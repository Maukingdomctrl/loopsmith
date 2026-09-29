/**
 * MaterialStroke — the universal stroke.
 *
 * All five brushes run through this one class. It owns the curve (the existing
 * `StrokePath`: smoothing → centripetal Catmull-Rom → arc-length resampling,
 * exact at any sub-pixel position), turns every resampled point into a
 * `BrushInput`, and hands it to a material model. What differs between brushes
 * is only what the model does with that input.
 *
 * It presents the same surface as `BrushStroke` / `EraserStroke`
 * (`addSample`, `previewInto`, `end`, `cancel`), so the canvas integration is a
 * one-line swap.
 *
 * PREVIEW IS INCREMENTAL. The composite of a pixel depends only on the
 * pre-stroke pixel and the material at that pixel, so a live preview only has
 * to redo the pixels that changed since the last frame. A long stroke with a
 * big brush therefore costs the same per frame as a short one.
 */

import type { Rect } from "@/types/geometry";
import type { StrokePoint, StrokeSample } from "@/types/raster";
import { DirtyTracker, RasterSurface } from "../surface";
import { hash2 } from "./noise";
import { StrokePath } from "../stroke";
import { RECT_EMPTY, rect, rectIsEmpty } from "@/lib/geometry/rect";
import { clamp01, mix, smootherstep, smoothstep } from "./curves";
import {
  resolveMouse,
  type BrushInput,
  type BrushModel,
  type MaterialStrokeOptions,
  type ModelContext,
  type MouseDynamics,
} from "./types";
import { createModel } from "./models";

/** Pen pressure is low-passed a little before it reaches the curve: a real
 *  digitizer reports quantized, slightly noisy values, and unfiltered they
 *  read as tiny width steps. 0.55 keeps the response instant to the eye. */
const PRESSURE_SMOOTHING = 0.55;

export class MaterialStroke {
  readonly options: MaterialStrokeOptions;

  private readonly surface: RasterSurface;
  private readonly path: StrokePath;
  private readonly baseline: Float32Array;
  /** Created with the first sample, so its seed can come from where the stroke
   *  starts (see `addSample`). */
  private model: BrushModel | null = null;
  private readonly hasPressure: boolean;
  private readonly scale: number;
  private readonly mouse: MouseDynamics;

  /** Everything this stroke has touched, integer pixels. */
  private readonly extent = new DirtyTracker();
  private lastTarget: RasterSurface | null = null;

  private ended = false;
  private startTime: number | null = null;
  private smoothedPressure = -1;

  private prevDistance = -1;
  private prevTime = 0;

  /** Set while the final flush runs, once the pen has lifted. */
  private finishing = false;
  private totalLength = Infinity;
  private taperLength = 0;

  constructor(surface: RasterSurface, options: MaterialStrokeOptions) {
    this.surface = surface;
    this.options = options;
    this.hasPressure = options.hasPressure;
    this.scale = options.scale && options.scale > 0 ? options.scale : 1;
    this.mouse = resolveMouse(options.brush, options.material);

    this.path = new StrokePath(options.brush.smoothing);
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
    if (this.startTime === null) this.startTime = sample.time;
    // Anything a material varies "at random" (how evenly a wet brush releases
    // its load, say) is seeded from where the stroke starts: two strokes are
    // not clones of each other, yet the same input still replays to the same
    // pixels.
    this.model ??= this.makeModel(
      this.options.seed ?? hash2(Math.round(sample.x * 4), Math.round(sample.y * 4), 0x5eed)
    );

    const raw = clamp01(sample.pressure);
    this.smoothedPressure =
      this.smoothedPressure < 0
        ? raw
        : this.smoothedPressure + (raw - this.smoothedPressure) * PRESSURE_SMOOTHING;

    this.path.addSample({ ...sample, pressure: this.smoothedPressure });
    this.flush();
  }

  /** Straight segment to a point — the shift-constrained case. */
  addLineTo(point: { x: number; y: number }, pressure = 1, time = 0): void {
    this.addSample({ x: point.x, y: point.y, pressure, tilt: 0, twist: 0, time });
  }

  /* ---------------------------------------------------------------- */
  /*  dabs                                                            */
  /* ---------------------------------------------------------------- */

  private flush(): void {
    const model = this.model;
    if (!model) return;
    const inputs: BrushInput[] = [];
    // `emitStamps` asks for the next spacing once per emitted point, in order,
    // so the input is built there and reused for the dab.
    this.path.emitStamps((pt) => {
      const input = this.makeInput(pt);
      inputs.push(input);
      return model.spacing(input);
    });
    for (const input of inputs) model.dab(input);
  }

  private makeInput(pt: StrokePoint): BrushInput {
    const o = this.options;
    const first = this.prevDistance < 0;
    const time = pt.time - (this.startTime ?? pt.time);
    const ds = first ? 0 : Math.max(0, pt.distance - this.prevDistance);
    const dt = first ? 0 : Math.max(0, time - this.prevTime);
    const velocity = pt.speed * this.scale;
    // A stroke that never moved is a tap. Its path length is float noise, not
    // exactly 0, so it is reported as an exact 0 for the models to test.
    const tap = this.finishing && this.totalLength < 1e-6;
    const remaining = tap
      ? 0
      : this.finishing
        ? Math.max(0, this.totalLength - pt.distance)
        : Infinity;

    const pressure = this.hasPressure
      ? clamp01(pt.pressure)
      : this.simulatePressure(pt, velocity, remaining, tap);

    this.prevDistance = pt.distance;
    this.prevTime = time;

    return {
      x: pt.x,
      y: pt.y,
      pressure,
      velocity,
      time,
      tilt: clamp01(pt.tilt / (Math.PI / 2)),
      azimuth: pt.azimuth,
      rotation: (o.angle ?? 0) + pt.twist,
      tangent: pt.tangent,
      distance: pt.distance,
      ds,
      dt,
      size: o.radius,
      first,
      remaining,
    };
  }

  /**
   * A mouse has no pressure, but a brush should still not be a fixed-width
   * pipe. The stand-in is what a hand does anyway: a stroke begins light and
   * settles in, lightens when it is flicked quickly, and eases off at the end.
   * Each brush chooses how much of that it wants (`MouseDynamics`) — a
   * technical pen wants none of it, an ink brush wants all of it. The result is
   * a continuous function of arc length and speed, never a step.
   */
  private simulatePressure(
    pt: StrokePoint, velocity: number, remaining: number, tap: boolean
  ): number {
    const m = this.mouse;
    let p = m.base;
    if (m.speedInfluence > 0) {
      p *= 1 - m.speedInfluence * smoothstep(0, m.speedRef, velocity);
    }
    if (tap) return p;
    if (m.ramp > 0) {
      p *= mix(m.rampFrom, 1, smootherstep(0, m.ramp * this.options.radius, pt.distance));
    }
    if (m.taper > 0 && this.taperLength > 0 && remaining < this.taperLength) {
      p *= mix(m.taperTo, 1, smootherstep(0, this.taperLength, remaining));
    }
    return clamp01(p);
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
   * Show the stroke so far. Only pixels the model changed since the previous
   * preview are recomposited (from the pre-stroke pixels, so nothing ever
   * darkens past the true result).
   */
  previewInto(target: RasterSurface = this.surface): void {
    if (this.ended) return;
    let region = this.takeChanged();

    // A different target holds none of what was drawn before: redo everything.
    if (target !== this.lastTarget) {
      const all = this.extentRect();
      if (!rectIsEmpty(all)) region = all;
      this.lastTarget = target;
    }
    if (!region) return;

    this.restoreBaseline(target, region);
    this.model?.composite(target, region);
    if (this.options.lockAlpha) target.keepAlpha(this.baseline, region);
    target.dirty.addRect(region);
  }

  /** Commit. Returns the touched region, or null if nothing was drawn. */
  end(): Rect | null {
    if (this.ended) return null;

    // Close the path first: the final span is what the end taper has to fit
    // into (dabs already laid down cannot be revised), so its length is only
    // known now.
    this.path.finish();
    this.totalLength = this.path.length;
    this.taperLength = Math.min(
      this.mouse.taper * this.options.radius,
      Math.max(0, this.totalLength - Math.max(0, this.prevDistance))
    );
    this.finishing = true;
    this.flush();
    this.model?.settle();
    this.ended = true;

    this.takeChanged();
    const region = this.extentRect();
    if (rectIsEmpty(region)) return null;

    this.restoreBaseline(this.surface, region);
    this.model?.composite(this.surface, region);
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
