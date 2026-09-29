/**
 * The eraser.
 *
 * TRUE ALPHA ERASING, not white paint. The coverage buffer is produced by the
 * identical brush machinery, then consumed by `surface.eraseCoverage`, which
 * scales all four premultiplied channels by (1 − coverage·strength). Because
 * storage is premultiplied, that IS `destination-out`: alpha falls, and the
 * un-premultiplied colour of the surviving fraction is unchanged.
 *
 * Sharing the brush kernel is the point. An eraser with its own falloff code
 * would eventually disagree with the brush at the same hardness, and the
 * classic symptom — a brush stroke that its own eraser cannot fully remove,
 * leaving a faint halo — is exactly that disagreement.
 */

import type { Vec2 } from "@/types/geometry";
import type { BrushSettings, StrokePoint, StrokeSample } from "@/types/raster";
import { CoverageBuffer, RasterSurface } from "./surface";
import { StrokePath } from "./stroke";
import { BrushEngine } from "./brush";
import { createRandom } from "./constants";
import { clamp } from "@/lib/geometry/scalar";
import type { Rect } from "@/types/geometry";
import { RECT_EMPTY, rectIntersect, rectIsEmpty } from "@/lib/geometry/rect";

export class EraserStroke {
  readonly settings: BrushSettings;
  private readonly surface: RasterSurface;
  private readonly coverage: CoverageBuffer;
  private readonly path: StrokePath;
  private readonly rng: () => number;
  private readonly baseline: Float32Array;
  private ended = false;

  constructor(surface: RasterSurface, settings: BrushSettings) {
    this.surface = surface;
    this.settings = settings;
    this.coverage = surface.createCoverage();
    this.path = new StrokePath(settings.smoothing, settings.curveAlpha);
    this.rng = createRandom(settings.seed);
    this.baseline = surface.data.slice();
  }

  get isEnded(): boolean { return this.ended; }

  addSample(sample: StrokeSample): void {
    if (this.ended) return;
    this.path.addSample(sample);
    this.flush();
  }

  addLineTo(point: Vec2, pressure = 1, time = 0): void {
    if (this.ended) return;
    this.path.addSample({ x: point.x, y: point.y, pressure, tilt: 0, twist: 0, time });
    this.flush();
  }

  private flush(): void {
    const pts = this.path.emitStamps((p) =>
      BrushEngine.spacingAt(this.settings, p, this.rng)
    );
    if (pts.length) {
      BrushEngine.stampPath(this.coverage, this.settings, pts, this.rng);
    }
  }

  /** Live preview: restore, then erase — same non-destructive scheme as the brush. */
  previewInto(target: RasterSurface = this.surface): void {
    if (this.ended) return;
    target.data.set(this.baseline);
    target.dirty.add(0, 0, target.width, target.height);
    target.eraseCoverage(this.coverage, this.settings.opacity, this.coverage.integerBounds());
  }

  end(): Rect | null {
    if (this.ended) return null;
    this.path.finish();
    this.flush();
    this.ended = true;

    const region = this.coverage.integerBounds();
    this.surface.data.set(this.baseline);
    if (region.w <= 0 || region.h <= 0) return null;

    this.surface.eraseCoverage(this.coverage, this.settings.opacity, region);
    return region;
  }

  cancel(): void {
    if (this.ended) return;
    this.ended = true;
    this.surface.data.set(this.baseline);
    this.surface.dirty.add(0, 0, this.surface.width, this.surface.height);
  }

  previewPolyline(): Vec2[] {
    return this.path.toPolyline();
  }
}

/** Single-tap erase. */
export function eraseDot(
  surface: RasterSurface,
  settings: BrushSettings,
  point: Vec2,
  pressure = 1
): Rect {
  const coverage = surface.createCoverage();
  const rng = createRandom(settings.seed);
  const p: StrokePoint = {
    x: point.x, y: point.y, distance: 0,
    tangent: { x: 1, y: 0 }, pressure, tilt: 0, twist: 0, speed: 0,
    time: 0, azimuth: 0,
  };
  BrushEngine.stampPath(coverage, settings, [p], rng);
  const region = coverage.integerBounds();
  surface.eraseCoverage(coverage, settings.opacity, region);
  return region;
}

/**
 * Erase everything — "clear layer".
 *
 * Distinct from `surface.clear()` only in that it honours `strength`, so a
 * partial global erase (a fade) is expressible. At strength 1 it is exactly
 * equivalent, and delegating keeps the fast path fast.
 */
export function eraseAll(surface: RasterSurface, strength = 1): Rect {
  const s = clamp(strength, 0, 1);
  if (s >= 1) {
    surface.clear();
    return { x: 0, y: 0, w: surface.width, h: surface.height };
  }
  if (s <= 0) return RECT_EMPTY;

  const keep = 1 - s;
  for (let i = 0; i < surface.data.length; i++) surface.data[i] *= keep;
  surface.dirty.add(0, 0, surface.width, surface.height);
  return { x: 0, y: 0, w: surface.width, h: surface.height };
}

/**
 * Erase through an arbitrary coverage mask — the bridge for lasso-based
 * deletion, so the existing selection flow can cut pixels without leaving the
 * premultiplied domain and without a Canvas2D round trip.
 */
export function eraseWithMask(
  surface: RasterSurface,
  mask: CoverageBuffer,
  strength = 1
): Rect {
  const region = mask.integerBounds();
  surface.eraseCoverage(mask, strength, region);
  return region;
}
