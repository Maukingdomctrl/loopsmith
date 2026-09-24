/**
 * The brush engine.
 *
 * A stamp is evaluated ANALYTICALLY — as a closed-form falloff over the
 * distance field of the brush shape — not by sampling a pre-rendered texture.
 * Two reasons, both load-bearing:
 *
 *  1. A texture must be regenerated whenever radius or hardness changes, and
 *     pressure changes the radius on every single stamp. Analytic evaluation
 *     has no such cache to invalidate and no resampling error.
 *  2. Texture sampling at fractional offsets needs interpolation, which
 *     softens hard brushes and makes the result renderer-dependent. Analytic
 *     evaluation is exact at any sub-pixel position, which is what makes a
 *     1.5 px line look like a 1.5 px line rather than a 2 px blur.
 *
 * Everything the engine produces is a CoverageBuffer; the surface does the
 * compositing. So "brush" and "eraser" differ only in which surface method
 * consumes the coverage.
 */

import type { Vec2 } from "@/types/geometry";
import type {
  BrushSettings,
  StrokePoint,
  StrokeSample,
} from "@/types/raster";
import { CoverageBuffer, RasterSurface } from "./surface";
import { StrokePath } from "./stroke";
import {
  EDGE_AA_WIDTH,
  MAX_SPACING_FRACTION,
  MIN_SPACING_FRACTION,
  MIN_SPACING_PX,
  SPEED_REFERENCE,
  STAMP_PADDING,
  SUPERSAMPLE,
  SUPERSAMPLE_RADIUS,
  applyCurve,
  createRandom,
} from "./constants";
import { clamp } from "@/lib/geometry/scalar";

/* ============================================================ */
/*  falloff                                                     */
/* ============================================================ */

/**
 * Coverage as a function of normalized distance from the stamp centre.
 *
 * `d` is 0 at the centre and 1 at the nominal edge. `aaBand` is the width of
 * the antialias transition expressed in the same normalized units, so a small
 * brush automatically gets a proportionally wider band — that is what keeps a
 * 1 px brush smooth instead of a hard square of four pixels.
 *
 * Hardness interpolates between a smoothstep shoulder (soft) and a pure
 * analytic edge (hard). The smoothstep is used rather than a true Gaussian
 * because it has compact support: a Gaussian never reaches zero, so every
 * stamp would touch its entire bounding box and the engine would be ~4× slower
 * for a difference below one 8-bit quantum.
 */
function falloff(d: number, hardness: number, aaBand: number): number {
  if (d >= 1) return 0;
  if (d <= 0) return 1;

  const h = clamp(hardness, 0, 1);

  // Hard case: coverage falls off only across the AA band at the rim.
  const edge = clamp((1 - d) / Math.max(1e-6, aaBand), 0, 1);
  if (h >= 0.999) return edge;

  // Soft case: smoothstep from the inner plateau (at d = h) out to d = 1.
  const inner = h;
  const soft = d <= inner
    ? 1
    : (() => {
        const t = clamp((1 - d) / Math.max(1e-6, 1 - inner), 0, 1);
        return t * t * (3 - 2 * t);
      })();

  // Blend toward the hard profile so the hardness slider is monotone and has
  // no discontinuity at h = 1.
  return soft * (1 - h) + Math.min(soft, edge) * h;
}

/** Normalized distance field for each brush shape, in stamp-local units. */
function shapeDistance(shape: BrushSettings["shape"], x: number, y: number): number {
  switch (shape) {
    case "square":
      // Chebyshev metric: a square is the L∞ unit ball.
      return Math.max(Math.abs(x), Math.abs(y));
    case "chisel": {
      // A flat nib: square along the nib axis, rounded across it. Produces the
      // calligraphic thick/thin variation when combined with followTangent.
      const ax = Math.abs(x), ay = Math.abs(y);
      return Math.max(ax, Math.hypot(ax * 0.35, ay));
    }
    default:
      return Math.hypot(x, y);
  }
}

/* ============================================================ */
/*  BrushEngine                                                 */
/* ============================================================ */

export interface StampParams {
  readonly center: Vec2;
  /** Radius along the stamp's local x, in surface px. */
  readonly radiusX: number;
  readonly radiusY: number;
  /** Stamp rotation, radians. */
  readonly angle: number;
  /** Per-stamp alpha, already including flow and its dynamics. */
  readonly alpha: number;
}

export class BrushEngine {
  /**
   * Rasterize one stamp into a coverage buffer.
   *
   * The inverse-transform-per-pixel formulation (rotate the pixel into stamp
   * space, evaluate the radial falloff) is exact for any rotation and any
   * fractional centre, and needs no per-stamp setup. The alternative —
   * transforming the shape into pixel space — requires polygon clipping and is
   * both slower and less accurate at small radii.
   */
  static stamp(
    coverage: CoverageBuffer,
    settings: BrushSettings,
    params: StampParams
  ): void {
    const { center, radiusX, radiusY, angle, alpha } = params;
    if (alpha <= 0 || radiusX <= 0 || radiusY <= 0) return;

    const reach = Math.max(radiusX, radiusY) + STAMP_PADDING;
    const x0 = Math.max(0, Math.floor(center.x - reach));
    const y0 = Math.max(0, Math.floor(center.y - reach));
    const x1 = Math.min(coverage.width, Math.ceil(center.x + reach) + 1);
    const y1 = Math.min(coverage.height, Math.ceil(center.y + reach) + 1);
    if (x1 <= x0 || y1 <= y0) return;

    const cos = Math.cos(-angle), sin = Math.sin(-angle);
    const invRx = 1 / radiusX, invRy = 1 / radiusY;
    // AA band in normalized units: one pixel expressed as a fraction of the
    // radius, so small brushes get a proportionally softer rim.
    const aaBand = clamp(EDGE_AA_WIDTH / Math.max(radiusX, radiusY), 1e-3, 1);

    const useMax = settings.accumulation === "wet";
    // Below ~3 px a single centre sample aliases visibly as the stamp crosses
    // pixel boundaries; ordered supersampling removes it deterministically.
    const superSample = Math.max(radiusX, radiusY) < SUPERSAMPLE_RADIUS;
    const S = superSample ? SUPERSAMPLE : 1;
    const invS2 = 1 / (S * S);
    const step = 1 / S;
    const offset = step * 0.5;

    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        let acc = 0;

        for (let sy = 0; sy < S; sy++) {
          const wy = py + offset + sy * step - center.y;
          for (let sx = 0; sx < S; sx++) {
            const wx = px + offset + sx * step - center.x;
            // Rotate into stamp space, then normalize by the axis radii.
            const lx = (wx * cos - wy * sin) * invRx;
            const ly = (wx * sin + wy * cos) * invRy;
            const d = shapeDistance(settings.shape, lx, ly);
            if (d < 1) acc += falloff(d, settings.hardness, aaBand);
          }
        }
        if (acc <= 0) continue;

        const value = acc * invS2 * alpha;
        if (useMax) coverage.addMax(px, py, value);
        else coverage.addOver(px, py, value);
      }
    }
    coverage.dirty.add(x0, y0, x1, y1);
  }

  /** Radius at a stroke point, after pressure and speed dynamics. */
  static radiusAt(settings: BrushSettings, p: StrokePoint, rng: () => number): number {
    let r = settings.radius;
    r *= applyCurve(p.pressure, settings.sizeByPressure);

    if (settings.sizeBySpeed.min !== settings.sizeBySpeed.max) {
      // Speed is normalized against a reference rather than a per-stroke max,
      // so the same gesture yields the same width every time — a per-stroke
      // normalization would make width depend on the stroke's own history.
      const norm = clamp(p.speed / SPEED_REFERENCE, 0, 1);
      r *= applyCurve(norm, settings.sizeBySpeed);
    }
    if (settings.sizeJitter > 0) {
      r *= 1 + (rng() * 2 - 1) * settings.sizeJitter;
    }
    return Math.max(0.05, r);
  }

  static alphaAt(settings: BrushSettings, p: StrokePoint): number {
    return clamp(settings.flow * applyCurve(p.pressure, settings.flowByPressure), 0, 1);
  }

  /** Stamp spacing in px, derived from the CURRENT diameter at this point. */
  static spacingAt(settings: BrushSettings, p: StrokePoint, rng: () => number): number {
    const r = BrushEngine.radiusAt(settings, p, rng);
    const frac = clamp(settings.spacing, MIN_SPACING_FRACTION, MAX_SPACING_FRACTION);
    return Math.max(MIN_SPACING_PX, r * 2 * frac);
  }

  /** Stamp every point of a resampled path. */
  static stampPath(
    coverage: CoverageBuffer,
    settings: BrushSettings,
    points: readonly StrokePoint[],
    rng: () => number
  ): void {
    for (const p of points) {
      const r = BrushEngine.radiusAt(settings, p, rng);
      const aspect = Math.max(0.01, settings.aspect);
      const angle = settings.followTangent
        ? Math.atan2(p.tangent.y, p.tangent.x) + settings.angle
        : settings.angle + p.twist;

      let cx = p.x, cy = p.y;
      if (settings.scatter > 0) {
        // Scatter perpendicular AND along the path, in radius units, so the
        // effect scales with the brush rather than with the canvas.
        const a = rng() * Math.PI * 2;
        const m = rng() * settings.scatter * r;
        cx += Math.cos(a) * m;
        cy += Math.sin(a) * m;
      }

      BrushEngine.stamp(coverage, settings, {
        center: { x: cx, y: cy },
        radiusX: r * aspect,
        radiusY: r,
        angle,
        alpha: BrushEngine.alphaAt(settings, p),
      });
    }
  }
}

/* ============================================================ */
/*  BrushStroke — the stateful session                          */
/* ============================================================ */

/**
 * One live stroke.
 *
 * Holds the coverage buffer for the stroke's ENTIRE duration and composites it
 * into the surface only on `end`. That is what makes overlapping stamps within
 * a stroke not darken each other, and it makes the whole stroke a single undo
 * step without any special-casing.
 *
 * `previewInto` exists because the user must see the stroke while drawing. It
 * composites the current coverage onto a copy of the pre-stroke surface state,
 * which is exact — the preview is not an approximation of the final result, it
 * IS the final result for the coverage accumulated so far.
 */
export class BrushStroke {
  readonly settings: BrushSettings;
  private readonly surface: RasterSurface;
  private readonly coverage: CoverageBuffer;
  private readonly path: StrokePath;
  private readonly rng: () => number;
  /** Pre-stroke pixels, so the preview can be recomposited non-destructively. */
  private readonly baseline: Float32Array;
  private ended = false;

  constructor(surface: RasterSurface, settings: BrushSettings) {
    this.surface = surface;
    this.settings = settings;
    this.coverage = surface.createCoverage();
    this.path = new StrokePath(settings.smoothing, settings.curveAlpha);
    // Seeded per stroke: identical input replays to identical pixels.
    this.rng = createRandom(settings.seed);
    this.baseline = surface.data.slice();
  }

  get isEnded(): boolean { return this.ended; }
  get strokeLength(): number { return this.path.length; }
  get coverageBuffer(): CoverageBuffer { return this.coverage; }

  /** Feed a sample and stamp whatever new arc length it made available. */
  addSample(sample: StrokeSample): void {
    if (this.ended) return;
    this.path.addSample(sample);
    this.flush();
  }

  /** Straight-line segment to a point — the shift-constrained case. */
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

  /**
   * Restore the pre-stroke pixels and composite the coverage so far.
   *
   * Restoring first is essential: compositing incrementally would apply
   * `opacity` repeatedly to the same pixels and the preview would darken past
   * the true result, then visibly snap back on release.
   */
  previewInto(target: RasterSurface = this.surface): void {
    if (this.ended) return;
    const region = this.coverage.integerBounds();
    target.data.set(this.baseline);
    target.dirty.add(0, 0, target.width, target.height);
    target.compositeCoverage(
      this.coverage,
      this.settings.color,
      this.settings.opacity,
      this.settings.blend,
      region
    );
  }

  /** Commit. Returns the dirty region, or null if nothing was drawn. */
  end(): ReturnType<CoverageBuffer["integerBounds"]> | null {
    if (this.ended) return null;
    // Flush the provisional tail, or the last stamps never appear.
    this.path.finish();
    this.flush();
    this.ended = true;

    const region = this.coverage.integerBounds();
    this.surface.data.set(this.baseline);
    if (region.w <= 0 || region.h <= 0) return null;

    this.surface.compositeCoverage(
      this.coverage,
      this.settings.color,
      this.settings.opacity,
      this.settings.blend,
      region
    );
    return region;
  }

  /** Abort: restore the surface exactly. */
  cancel(): void {
    if (this.ended) return;
    this.ended = true;
    this.surface.data.set(this.baseline);
    this.surface.dirty.add(0, 0, this.surface.width, this.surface.height);
  }

  /** Polyline of the path so far, for an on-canvas preview overlay. */
  previewPolyline(): Vec2[] {
    return this.path.toPolyline();
  }
}

/** Single dot — a tap with no movement still has to mark the canvas. */
export function stampDot(
  surface: RasterSurface,
  settings: BrushSettings,
  point: Vec2,
  pressure = 1
): void {
  const coverage = surface.createCoverage();
  const rng = createRandom(settings.seed);
  const p: StrokePoint = {
    x: point.x, y: point.y, distance: 0,
    tangent: { x: 1, y: 0 }, pressure, tilt: 0, twist: 0, speed: 0,
  };
  BrushEngine.stampPath(coverage, settings, [p], rng);
  surface.compositeCoverage(
    coverage, settings.color, settings.opacity, settings.blend,
    coverage.integerBounds()
  );
}
