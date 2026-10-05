/**
 * MaterialStroke — the universal stroke.
 *
 * Every brush runs through this one class. It owns the curve (the existing
 * `StrokePath`: smoothing → centripetal Catmull-Rom → arc-length resampling,
 * exact at any sub-pixel position), turns every resampled point into a
 * `BrushInput` through the brush's dynamics (dynamics.ts), and hands it to a
 * material model. What differs between brushes is data — the preset's
 * dynamics — and what the model does with the input.
 *
 * It presents the same surface as `BrushStroke` / `EraserStroke`
 * (`addSample`, `previewInto`, `end`, `cancel`), so the canvas integration is a
 * one-line swap.
 *
 * BLEND MODES work like Photoshop's brush Mode: the stroke is built on its own,
 * then blended onto the layer once with the full separable-blend formula (see
 * `compositeInto`). A stroke therefore never multiplies or dodges over itself
 * where it overlaps — only over what was on the layer before it. An ERASING
 * brush is built the same way and removes what lies under its coverage.
 *
 * PREVIEW IS INCREMENTAL. The composite of a pixel depends only on the
 * pre-stroke pixel and the material at that pixel, so a live preview only has
 * to redo the pixels that changed since the last frame. A long stroke with a
 * big brush therefore costs the same per frame as a short one.
 */

import type { Rect } from "@/types/geometry";
import type { StrokeSample } from "@/types/raster";
import { DirtyTracker, RasterSurface } from "../surface";
import { hash2 } from "./noise";
import { compositeInto } from "../color";
import { StrokePath } from "../stroke";
import { RECT_EMPTY, rect, rectIsEmpty } from "@/lib/geometry/rect";
import { clamp01 } from "./curves";
import { DynamicsEvaluator } from "./dynamics";
import {
  type BrushInput,
  type BrushModel,
  type MaterialStrokeOptions,
  type ModelContext,
} from "./types";
import { createModel } from "./models";

export class MaterialStroke {
  readonly options: MaterialStrokeOptions;

  private readonly surface: RasterSurface;
  private readonly path: StrokePath;
  private readonly baseline: Float32Array;
  /** Created with the first sample, so its seed can come from where the stroke
   *  starts (see `addSample`). */
  private model: BrushModel | null = null;
  private readonly scale: number;
  private readonly dynamics: DynamicsEvaluator;
  private readonly erase: boolean;

  /** Everything this stroke has touched, integer pixels. */
  private readonly extent = new DirtyTracker();
  private lastTarget: RasterSurface | null = null;
  /** The stroke alone, over transparent — only for non-normal modes. */
  private scratch: RasterSurface | null = null;

  private ended = false;

  constructor(surface: RasterSurface, options: MaterialStrokeOptions) {
    this.surface = surface;
    this.options = options;
    this.scale = options.scale && options.scale > 0 ? options.scale : 1;
    this.dynamics = new DynamicsEvaluator(options, this.scale);
    this.erase = options.erase ?? !!options.brush.erase;

    this.path = new StrokePath(
      this.dynamics.smoothing, undefined, 1 / this.scale, options.pressureSmoothing, options.pressureRange
    );
    // Pre-stroke pixels: the previous pigment / material state. Also what a
    // preview is recomposited from, so it is never a running approximation.
    this.baseline = surface.data.slice();
  }

  get isEnded(): boolean { return this.ended; }
  get strokeLength(): number { return this.path.length; }

  /* ---------------------------------------------------------------- */
  /*  input                                                           */
  /* ---------------------------------------------------------------- */

  private makeModel(seed: number): BrushModel {
    const o = this.options;
    const ctx: ModelContext = {
      width: this.surface.width,
      height: this.surface.height,
      baseline: this.baseline,
      color: o.color,
      intensity: o.intensity,
      material: o.material ?? o.brush.defaultMaterial ?? "",
      seed,
      size: o.radius,
      scale: this.scale,
      angle: o.angle ?? 0,
      shape: o.brush.shape,
      aspect: o.brush.aspect ?? 1,
    };
    return createModel(o.brush.model, ctx);
  }

  addSample(sample: StrokeSample): void {
    if (this.ended) return;
    this.dynamics.begin(sample.time);
    // Anything a material varies "at random" (how evenly a wet brush releases
    // its load, say) — and the preset's jitter — is seeded from where the
    // stroke starts: two strokes are not clones of each other, yet the same
    // input still replays to the same pixels.
    if (!this.model) {
      const seed = this.options.seed ?? hash2(Math.round(sample.x * 4), Math.round(sample.y * 4), 0x5eed);
      this.model = this.makeModel(seed);
      this.dynamics.setSeed(seed);
    }

    // Pressure goes to the curve as reported: StrokePath smooths it between
    // neighbouring samples without lag and interpolates it C¹ along the path.
    this.path.addSample({ ...sample, pressure: clamp01(sample.pressure) });
    this.flush();
  }

  /** Straight segment to a point — the shift-constrained case. */
  addLineTo(point: { x: number; y: number }, pressure = 1, time = 0): void {
    this.addSample({ x: point.x, y: point.y, pressure, tilt: 0, twist: 0, time });
  }

  /* ---------------------------------------------------------------- */
  /*  dabs                                                            */
  /* ---------------------------------------------------------------- */

  /** `final`: the pen has lifted — also lay a dab at the exact end of the path. */
  private flush(final = false): void {
    const model = this.model;
    if (!model) return;
    const inputs: BrushInput[] = [];
    // `emitStamps` asks for the next spacing once per emitted point, in order,
    // so the input is built there and reused for the dab.
    this.path.emitStamps((pt) => {
      const input = this.dynamics.evaluate(pt);
      inputs.push(input);
      return model.spacing(input);
    }, final);
    for (const input of inputs) model.dab(input);
  }

  /* ---------------------------------------------------------------- */
  /*  compositing                                                     */
  /* ---------------------------------------------------------------- */

  /** Pixels changed since the last call, as a clipped integer rect. */
  private takeChanged(): Rect | null {
    if (!this.model) return null;
    const d = this.model.dirty.toRect();
    this.model.dirty.reset();
    if (rectIsEmpty(d)) return null;
    const r = this.surface.clipRect(d);
    if (rectIsEmpty(r)) return null;
    this.extent.addRect(r);
    return r;
  }

  private extentRect(): Rect {
    const d = this.extent.toRect();
    if (rectIsEmpty(d)) return RECT_EMPTY;
    const r = this.surface.clipRect(d);
    return rectIsEmpty(r) ? RECT_EMPTY : rect(r.x, r.y, r.w, r.h);
  }

  private restoreBaseline(target: RasterSurface, r: Rect): void {
    const w = this.surface.width * 4;
    for (let y = r.y; y < r.y + r.h; y++) {
      const a = y * w + r.x * 4;
      target.data.set(this.baseline.subarray(a, a + r.w * 4), a);
    }
    target.dirty.addRect(r);
  }

  /**
   * Lay the stroke over `target`, which holds the pre-stroke pixels in `r`.
   * Normal mode lets the material composite directly (water glazes over the
   * paint beneath). Any other mode renders the stroke alone first, then blends
   * that colour and alpha onto the layer, in float, per pixel; an eraser
   * removes that alpha's share of every channel (destination-out).
   */
  private compositeRegion(target: RasterSurface, r: Rect): void {
    const model = this.model;
    if (!model) return;
    const mode = this.options.blend ?? "normal";
    if (mode === "normal" && !this.erase) {
      model.composite(target, r);
      return;
    }
    const scratch = (this.scratch ??= new RasterSurface(this.surface.width, this.surface.height));
    const s = scratch.data;
    const out = target.data;
    const w = this.surface.width * 4;
    for (let y = r.y; y < r.y + r.h; y++) {
      const a = y * w + r.x * 4;
      s.fill(0, a, a + r.w * 4);
    }
    model.composite(scratch, r);
    if (this.erase) {
      for (let y = r.y; y < r.y + r.h; y++) {
        let i = y * w + r.x * 4;
        for (let x = 0; x < r.w; x++, i += 4) {
          const sa = s[i + 3];
          if (sa <= 0) continue;
          const keep = sa >= 1 ? 0 : 1 - sa;
          out[i] *= keep;
          out[i + 1] *= keep;
          out[i + 2] *= keep;
          out[i + 3] *= keep;
        }
      }
      return;
    }
    for (let y = r.y; y < r.y + r.h; y++) {
      let i = y * w + r.x * 4;
      for (let x = 0; x < r.w; x++, i += 4) {
        const sa = s[i + 3];
        if (sa <= 0) continue;
        const k = 1 / sa;
        compositeInto(out, i, s[i] * k, s[i + 1] * k, s[i + 2] * k, sa > 1 ? 1 : sa, mode);
      }
    }
  }

  /**
   * Show the stroke so far. Only pixels the model changed since the previous
   * preview are recomposited (from the pre-stroke pixels, so nothing ever
   * darkens past the true result). Returns the rect it recomposited, so a
   * display can refresh just that, or null if nothing changed.
   */
  previewInto(target: RasterSurface = this.surface): Rect | null {
    if (this.ended) return null;
    let region = this.takeChanged();

    // A different target holds none of what was drawn before: redo everything.
    if (target !== this.lastTarget) {
      const all = this.extentRect();
      if (!rectIsEmpty(all)) region = all;
      this.lastTarget = target;
    }
    if (!region) return null;

    this.restoreBaseline(target, region);
    this.compositeRegion(target, region);
    if (this.options.lockAlpha) target.keepAlpha(this.baseline, region);
    target.dirty.addRect(region);
    return region;
  }

  /** Commit. Returns the touched region, or null if nothing was drawn. */
  end(): Rect | null {
    if (this.ended) return null;

    // Close the path first: the final span is what the end taper has to fit
    // into (dabs already laid down cannot be revised), so its length is only
    // known now.
    this.path.finish();
    this.dynamics.finish(this.path.length);
    this.flush(true);
    this.model?.settle();
    this.ended = true;

    this.takeChanged();
    const region = this.extentRect();
    if (rectIsEmpty(region)) return null;

    this.restoreBaseline(this.surface, region);
    this.compositeRegion(this.surface, region);
    if (this.options.lockAlpha) this.surface.keepAlpha(this.baseline, region);
    this.surface.dirty.addRect(region);
    return region;
  }

  /** Abort: restore the surface exactly. */
  cancel(): void {
    if (this.ended) return;
    this.ended = true;
    this.takeChanged();
    const region = this.extentRect();
    if (!rectIsEmpty(region)) this.restoreBaseline(this.surface, region);
    if (this.lastTarget && this.lastTarget !== this.surface && !rectIsEmpty(region)) {
      this.restoreBaseline(this.lastTarget, region);
    }
  }
}
