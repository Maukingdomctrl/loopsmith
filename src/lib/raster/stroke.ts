/**
 * Stroke path mathematics: smoothing, arc-length parameterization, resampling.
 *
 * THE PROBLEM THIS SOLVES. Pointer events arrive at an irregular rate and at
 * irregular spacing — 4 px apart when moving slowly, 60 px apart when fast,
 * and with a gap whenever the main thread is busy. Stamping once per event
 * therefore produces a stroke whose density tracks the user's hand speed and
 * the browser's scheduler: visible beading when slow, gaps when fast, and a
 * clump at every event boundary.
 *
 * THE FIX, in three stages:
 *   1. SMOOTH the raw samples (one-pole filter) to remove jitter.
 *   2. FIT a C¹-continuous curve through them — centripetal Catmull-Rom,
 *      converted to cubic Bézier segments.
 *   3. RESAMPLE by ARC LENGTH, so stamps are placed at exact geometric
 *      intervals independent of event timing, with the leftover residual
 *      carried across event boundaries so spacing is continuous there too.
 *
 * Stage 3's residual carry is the part most implementations miss, and it is
 * exactly what causes the clump-per-event artifact.
 */

import type { Vec2 } from "@/types/geometry";
import type { StrokePoint, StrokeSample } from "@/types/raster";
import {
  ARCLEN_NEWTON_ITERS,
  ARCLEN_SUBDIVISIONS,
  CURVE_ALPHA_CENTRIPETAL,
  KNOT_EPSILON,
  MAX_INPUT_SMOOTHING,
  MIN_SAMPLE_DISTANCE,
  MIN_SPACING_PX,
  SPEED_SMOOTHING,
} from "./constants";
import { clamp } from "@/lib/geometry/scalar";

/* ============================================================ */
/*  cubic Bézier                                                */
/* ============================================================ */

export interface CubicSegment {
  readonly p0: Vec2;
  readonly p1: Vec2;
  readonly p2: Vec2;
  readonly p3: Vec2;

  /** Dynamics at the segment's endpoints, interpolated across it. */
  readonly startDynamics: SampleDynamics;
  readonly endDynamics: SampleDynamics;

  /** Cumulative arc length at p0, measured from the stroke origin. */
  readonly startDistance: number;

  /** Length of this segment. */
  readonly length: number;

  /** Monotonic t → arc-length table, ARCLEN_SUBDIVISIONS + 1 entries. */
  readonly lut: Float64Array;
}

export interface SampleDynamics {
  readonly pressure: number;
  readonly tilt: number;
  readonly twist: number;
  readonly speed: number;
  readonly time: number;
  readonly azimuth: number;
}

export const bezierPoint = (s: CubicSegment, t: number): Vec2 => {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * s.p0.x + b * s.p1.x + c * s.p2.x + d * s.p3.x,
    y: a * s.p0.y + b * s.p1.y + c * s.p2.y + d * s.p3.y,
  };
};

/** First derivative. Its normalization is the unit tangent. */
export const bezierDerivative = (s: CubicSegment, t: number): Vec2 => {
  const u = 1 - t;
  const a = 3 * u * u, b = 6 * u * t, c = 3 * t * t;
  return {
    x: a * (s.p1.x - s.p0.x) + b * (s.p2.x - s.p1.x) + c * (s.p3.x - s.p2.x),
    y: a * (s.p1.y - s.p0.y) + b * (s.p2.y - s.p1.y) + c * (s.p3.y - s.p2.y),
  };
};

/**
 * Unit tangent, with a degenerate-derivative fallback.
 *
 * The derivative genuinely vanishes at a cusp or when three control points
 * coincide — common when the user holds still. Falling back to the chord
 * p3−p0 keeps the tangent defined, which matters because `followTangent`
 * brushes and the arrow head would otherwise snap to an arbitrary direction.
 */
export function bezierTangent(s: CubicSegment, t: number): Vec2 {
  const d = bezierDerivative(s, t);
  const len = Math.hypot(d.x, d.y);
  if (len > KNOT_EPSILON) return { x: d.x / len, y: d.y / len };
  const cx = s.p3.x - s.p0.x, cy = s.p3.y - s.p0.y;
  const cl = Math.hypot(cx, cy);
  return cl > KNOT_EPSILON ? { x: cx / cl, y: cy / cl } : { x: 1, y: 0 };
}

/**
 * Build the t → arc-length lookup table by fixed-step polyline integration.
 *
 * Not Gauss–Legendre: GL gives a more accurate TOTAL length but no inverse
 * mapping, and what resampling actually needs is length⁻¹(s). A monotonic LUT
 * plus Newton refinement inverts in O(log n) and is exact at the knots.
 * Fixed subdivision count also keeps the result deterministic, which adaptive
 * subdivision would not.
 */
function buildArcLengthLUT(
  p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2
): { lut: Float64Array; length: number } {
  const n = ARCLEN_SUBDIVISIONS;
  const lut = new Float64Array(n + 1);
  let prevX = p0.x, prevY = p0.y, acc = 0;

  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    const x = a * p0.x + b * p1.x + c * p2.x + d * p3.x;
    const y = a * p0.y + b * p1.y + c * p2.y + d * p3.y;
    acc += Math.hypot(x - prevX, y - prevY);
    lut[i] = acc;
    prevX = x; prevY = y;
  }
  return { lut, length: acc };
}

/**
 * Invert the arc-length map: find t such that length(t) ≈ target.
 *
 * Binary search on the LUT for the bracketing interval, linear interpolation
 * for the initial guess, then Newton steps using |B'(t)| as the derivative of
 * arc length. Two Newton iterations take the error from ~1e-2 px (LUT-only) to
 * below 1e-6 px, which is three orders of magnitude finer than the minimum
 * stamp spacing — so spacing error never accumulates along a long stroke.
 */
function tAtLength(s: CubicSegment, target: number): number {
  const lut = s.lut;
  const n = lut.length - 1;
  if (target <= 0) return 0;
  if (target >= s.length) return 1;

  let lo = 0, hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lut[mid] < target) lo = mid; else hi = mid;
  }
  const l0 = lut[lo], l1 = lut[hi];
  const span = l1 - l0;
  let t = (lo + (span > KNOT_EPSILON ? (target - l0) / span : 0)) / n;

  for (let i = 0; i < ARCLEN_NEWTON_ITERS; i++) {
    const d = bezierDerivative(s, t);
    const speed = Math.hypot(d.x, d.y);
    if (speed <= KNOT_EPSILON) break;
    // Re-integrate from the bracketing knot rather than from 0: the local
    // estimate is far better conditioned than a global one.
    const current = l0 + approximateLength(s, lo / n, t);
    t = clamp(t - (current - target) / speed, 0, 1);
  }
  return t;
}

/** Short-span polyline length, for Newton's residual. */
function approximateLength(s: CubicSegment, tA: number, tB: number): number {
  if (tB <= tA) return 0;
  const steps = 4;
  let acc = 0;
  let prev = bezierPoint(s, tA);
  for (let i = 1; i <= steps; i++) {
    const p = bezierPoint(s, tA + ((tB - tA) * i) / steps);
    acc += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return acc;
}

/* ============================================================ */
/*  centripetal Catmull-Rom → Bézier                            */
/* ============================================================ */

/**
 * Convert four consecutive knots into the cubic Bézier for the p1→p2 span.
 *
 * WHY CENTRIPETAL (α = 0.5) AND NOT UNIFORM. With uniform parameterization
 * (α = 0), Catmull-Rom provably overshoots when consecutive knots are unevenly
 * spaced: the curve loops outside the control polygon and can self-intersect.
 * That is precisely the situation created by irregular pointer sampling, and
 * the visible symptom is a small hook at every sharp corner of a stroke.
 * Centripetal parameterization (Yuksel, Schaefer & Keyser) is guaranteed free
 * of cusps and self-intersections within a segment, at no extra cost beyond
 * three sqrt calls.
 */
function catmullRomToBezier(
  p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, alpha: number
): { c1: Vec2; c2: Vec2 } {
  const d01 = Math.pow(Math.hypot(p1.x - p0.x, p1.y - p0.y), alpha);
  const d12 = Math.pow(Math.hypot(p2.x - p1.x, p2.y - p1.y), alpha);
  const d23 = Math.pow(Math.hypot(p3.x - p2.x, p3.y - p2.y), alpha);

  // Coincident knots make the weights singular; degrade to the chord, which is
  // the correct limit and avoids a NaN propagating into the whole stroke.
  if (d12 <= KNOT_EPSILON) {
    return {
      c1: { x: p1.x + (p2.x - p1.x) / 3, y: p1.y + (p2.y - p1.y) / 3 },
      c2: { x: p1.x + (2 * (p2.x - p1.x)) / 3, y: p1.y + (2 * (p2.y - p1.y)) / 3 },
    };
  }

  const safe01 = Math.max(d01, KNOT_EPSILON);
  const safe23 = Math.max(d23, KNOT_EPSILON);

  const m1x = (p2.x - p1.x) + d12 * ((p1.x - p0.x) / safe01 - (p2.x - p0.x) / (safe01 + d12));
  const m1y = (p2.y - p1.y) + d12 * ((p1.y - p0.y) / safe01 - (p2.y - p0.y) / (safe01 + d12));
  const m2x = (p2.x - p1.x) + d12 * ((p3.x - p2.x) / safe23 - (p3.x - p1.x) / (d12 + safe23));
  const m2y = (p2.y - p1.y) + d12 * ((p3.y - p2.y) / safe23 - (p3.y - p1.y) / (d12 + safe23));

  return {
    c1: { x: p1.x + m1x / 3, y: p1.y + m1y / 3 },
    c2: { x: p2.x - m2x / 3, y: p2.y - m2y / 3 },
  };
}

/* ============================================================ */
/*  StrokePath                                                  */
/* ============================================================ */

/**
 * Incremental stroke path builder.
 *
 * Stateful and append-only, because that is the shape of the problem: samples
 * arrive over time and stamps must be emitted as they do, with no
 * recomputation of what was already drawn. Three invariants make that safe:
 *
 *  - a new sample only ever finalizes the segment ENDING two knots back, so an
 *    already-stamped segment is never revised;
 *  - `residual` carries the sub-spacing remainder across calls, so stamp
 *    spacing is continuous across event boundaries;
 *  - `emitted` is monotonic, so no stamp is ever produced twice.
 */
export class StrokePath {
  private knots: Vec2[] = [];
  private dynamics: SampleDynamics[] = [];
  private segments: CubicSegment[] = [];

  /** Total arc length of all finalized segments. */
  private totalLength = 0;
  /** Arc length already consumed by emitted stamps. */
  private emitted = 0;

  private smoothed: Vec2 | null = null;
  private lastRaw: StrokeSample | null = null;
  private speed = 0;

  private readonly smoothing: number;
  private readonly alpha: number;

  constructor(smoothing: number, curveAlpha = CURVE_ALPHA_CENTRIPETAL) {
    this.smoothing = clamp(smoothing, 0, 1) * MAX_INPUT_SMOOTHING;
    this.alpha = clamp(curveAlpha, 0, 1);
  }

  get length(): number { return this.totalLength; }
  get segmentCount(): number { return this.segments.length; }
  get knotCount(): number { return this.knots.length; }
  get isEmpty(): boolean { return this.knots.length === 0; }

  /**
   * Append a raw sample.
   *
   * Returns true if a knot was actually added. Samples closer than
   * MIN_SAMPLE_DISTANCE are dropped: they contribute no direction information
   * and their near-zero chord makes the centripetal weights ill-conditioned.
   * Their DYNAMICS are still merged into the previous knot, so pressure built
   * up while holding still is not lost.
   */
  addSample(sample: StrokeSample): boolean {
    const dyn = this.updateDynamics(sample);
    const point = this.applySmoothing(sample);

    if (this.knots.length > 0) {
      const prev = this.knots[this.knots.length - 1];
      if (Math.hypot(point.x - prev.x, point.y - prev.y) < MIN_SAMPLE_DISTANCE) {
        // Dwell: keep the strongest dynamics seen at this position. Time moves
        // on with the pointer, so a pause is not smeared over the next span.
        const i = this.dynamics.length - 1;
        this.dynamics[i] = {
          pressure: Math.max(this.dynamics[i].pressure, dyn.pressure),
          tilt: dyn.tilt,
          twist: dyn.twist,
          speed: dyn.speed,
          time: dyn.time,
          azimuth: dyn.azimuth,
        };
        return false;
      }
    }

    this.knots.push(point);
    this.dynamics.push(dyn);
    this.rebuildTail();
    return true;
  }

  /** One-pole low-pass on position. Removes stylus jitter and mouse stair-stepping. */
  private applySmoothing(s: StrokeSample): Vec2 {
    const raw = { x: s.x, y: s.y };
    if (!this.smoothed || this.smoothing <= 0) {
      this.smoothed = raw;
      return raw;
    }
    const k = this.smoothing;
    const next = {
      x: this.smoothed.x + (raw.x - this.smoothed.x) * (1 - k),
      y: this.smoothed.y + (raw.y - this.smoothed.y) * (1 - k),
    };
    this.smoothed = next;
    return next;
  }

  /** Exponentially smoothed speed. Raw per-event speed is far too noisy to
   *  drive brush size — it spikes on every scheduler hiccup. */
  private updateDynamics(s: StrokeSample): SampleDynamics {
    if (this.lastRaw) {
      const dt = Math.max(1, s.time - this.lastRaw.time);
      const dist = Math.hypot(s.x - this.lastRaw.x, s.y - this.lastRaw.y);
      const instant = dist / dt;
      this.speed = this.speed * SPEED_SMOOTHING + instant * (1 - SPEED_SMOOTHING);
    }
    this.lastRaw = s;
    return {
      pressure: clamp(s.pressure, 0, 1),
      tilt: s.tilt,
      twist: s.twist,
      speed: this.speed,
      time: s.time,
      azimuth: s.azimuth ?? 0,
    };
  }

  /**
   * Finalize any segment that the newest knot has made determinate.
   *
   * Segment i spans knot i → knot i+1, and a Catmull-Rom span needs one knot on
   * either side. So with k knots, spans up to index k−3 are final (each has a
   * real knot beyond it) and the newest span is provisional. Only final spans
   * are pushed, which is what guarantees no already-stamped geometry is
   * revised.
   */
  private rebuildTail(): void {
    const k = this.knots.length;
    const wanted = Math.max(0, k - 2);
    while (this.segments.length < wanted) {
      const i = this.segments.length;
      this.segments.push(this.makeSegment(i));
    }
  }

  private makeSegment(i: number): CubicSegment {
    const k = this.knots;
    // End knots are duplicated (rather than extrapolated) so the curve is
    // guaranteed to pass through the first and last sample exactly — an
    // extrapolated phantom knot would let the stroke start slightly off the
    // point the user touched.
    //
    // Segment i runs from knot i to knot i+1. (It used to run from i+1 to i+2,
    // which silently dropped the FIRST span of every stroke: the mark began one
    // pointer event away from where the pen touched down.)
    const p1 = k[i];
    const p2 = k[i + 1] ?? p1;
    const p0 = k[i - 1] ?? p1;
    const p3 = k[i + 2] ?? p2;

    const { c1, c2 } = catmullRomToBezier(p0, p1, p2, p3, this.alpha);
    const { lut, length } = buildArcLengthLUT(p1, c1, c2, p2);

    const startDistance = this.totalLength;
    this.totalLength += length;

    return {
      p0: p1, p1: c1, p2: c2, p3: p2,
      startDynamics: this.dynamics[i],
      endDynamics: this.dynamics[i + 1] ?? this.dynamics[i],
      startDistance,
      length,
      lut,
    };
  }

  /**
   * Close the stroke: flush the provisional tail so the last samples are drawn.
   *
   * Without this the final knot never becomes a segment and the stroke visibly
   * stops short of where the user lifted — the single most noticeable bug in
   * an incremental stroke builder. Two more cases are handled here:
   *
   *  - Input smoothing is a one-pole filter, so the last SMOOTHED knot trails
   *    the pointer. The true last position is appended, so the stroke ends
   *    where the pen lifted rather than a few pixels short of it.
   *  - A stroke with a single knot (a tap) becomes one zero-length segment, so
   *    it still emits its dot instead of leaving no mark at all.
   */
  finish(): void {
    const raw = this.lastRaw;
    const last = this.knots[this.knots.length - 1];
    if (raw && last && Math.hypot(raw.x - last.x, raw.y - last.y) >= MIN_SAMPLE_DISTANCE) {
      this.knots.push({ x: raw.x, y: raw.y });
      this.dynamics.push({
        pressure: clamp(raw.pressure, 0, 1),
        tilt: raw.tilt,
        twist: raw.twist,
        speed: this.speed,
        time: raw.time,
        azimuth: raw.azimuth ?? 0,
      });
    }

    const k = this.knots.length;
    if (k === 0) return;
    // Duplicate the terminal knot so the remaining spans become determinate.
    const wanted = Math.max(1, k - 1);
    while (this.segments.length < wanted) {
      this.segments.push(this.makeSegment(this.segments.length));
    }
  }

  /**
   * Emit stamp positions at constant arc-length spacing.
   *
   * `spacingAt` receives the interpolated dynamics so spacing can track a
   * pressure-varying radius — a tapering stroke must not thin out its stamp
   * density as it narrows.
   */
  emitStamps(spacingAt: (p: StrokePoint) => number): StrokePoint[] {
    const out: StrokePoint[] = [];
    if (this.segments.length === 0) return out;

    // A stroke that has only ever received one position still deserves a dot.
    if (this.emitted === 0) {
      const first = this.pointAtDistance(0);
      if (first) {
        out.push(first);
        this.emitted = Math.max(MIN_SPACING_PX, spacingAt(first));
      }
    }

    let guard = 0;
    while (this.emitted <= this.totalLength) {
      if (++guard > 1e6) break; // spacing function returning ~0 cannot hang us
      const p = this.pointAtDistance(this.emitted);
      if (!p) break;
      out.push(p);
      this.emitted += Math.max(MIN_SPACING_PX, spacingAt(p));
    }
    return out;
  }

  /** Exact point at an arc-length position, with interpolated dynamics. */
  pointAtDistance(distance: number): StrokePoint | null {
    if (this.segments.length === 0) return null;
    const d = clamp(distance, 0, this.totalLength);

    // Binary search the segment containing `d`.
    let lo = 0, hi = this.segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.segments[mid].startDistance <= d) lo = mid; else hi = mid - 1;
    }
    const seg = this.segments[lo];
    const local = d - seg.startDistance;
    const t = tAtLength(seg, local);
    const pos = bezierPoint(seg, t);
    const tan = bezierTangent(seg, t);

    // Dynamics are interpolated in ARC LENGTH, not in t. Interpolating in t
    // would make pressure change faster through the tightly-curved parts of a
    // segment, which reads as a pressure wobble the user did not apply.
    const f = seg.length > KNOT_EPSILON ? local / seg.length : 0;
    const a = seg.startDynamics, b = seg.endDynamics;

    return {
      x: pos.x,
      y: pos.y,
      distance: d,
      tangent: tan,
      pressure: a.pressure + (b.pressure - a.pressure) * f,
      tilt: a.tilt + (b.tilt - a.tilt) * f,
      twist: a.twist + (b.twist - a.twist) * f,
      speed: a.speed + (b.speed - a.speed) * f,
      time: a.time + (b.time - a.time) * f,
      azimuth: a.azimuth + (b.azimuth - a.azimuth) * f,
    };
  }

  /** Uniform resample of the whole path. Used by shape-from-stroke and tests. */
  resample(spacing: number): StrokePoint[] {
    const step = Math.max(MIN_SPACING_PX, spacing);
    const out: StrokePoint[] = [];
    for (let d = 0; d <= this.totalLength; d += step) {
      const p = this.pointAtDistance(d);
      if (p) out.push(p);
    }
    const end = this.pointAtDistance(this.totalLength);
    if (end && (out.length === 0 || out[out.length - 1].distance < this.totalLength)) {
      out.push(end);
    }
    return out;
  }

  /** Polyline approximation, for overlay previews. */
  toPolyline(tolerance = 0.5): Vec2[] {
    return this.resample(Math.max(1, tolerance * 4)).map((p) => ({ x: p.x, y: p.y }));
  }
}

/**
 * Straight-line path between two points — the shift-constrained stroke, and
 * the primitive the line/arrow shapes stamp along.
 *
 * Built by feeding two knots through the same machinery rather than as a
 * special case, so a straight stroke and a curved one share every code path
 * and cannot diverge in spacing, dynamics or endpoint handling.
 */
export function linearPath(from: Vec2, to: Vec2, pressure = 1): StrokePath {
  const path = new StrokePath(0, 0);
  const base = { pressure, tilt: 0, twist: 0, time: 0 };
  path.addSample({ ...base, x: from.x, y: from.y });
  path.addSample({ ...base, x: to.x, y: to.y, time: 16 });
  path.finish();
  return path;
}
