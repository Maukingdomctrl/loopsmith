/**
 * Continuous response curves.
 *
 * Every quantity a brush derives from pressure, speed or tilt goes through a
 * function in this file, and every one of them is smooth and monotone. There
 * are no thresholds and no lookup buckets: two pressures a hair apart always
 * produce two widths / densities a hair apart. That is the property that keeps
 * a stroke free of width jumps and density steps whatever the pen reports.
 */

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Hermite smoothstep, C¹ at both ends. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-9));
  return t * t * (3 - 2 * t);
}

/** Perlin's smootherstep, C² at both ends. Used where a second derivative
 *  jump would show as a crease (softness ramps, ends of tapers). */
export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-9));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * A pressure → quantity curve.
 *
 *   t   = pressure ^ gamma          (>1: needs pressing; <1: responds early)
 *   t   = mix(t, smootherstep(t), ease)   (flattens both ends: a natural pen feel)
 *   out = from + (to − from) · t
 *
 * Monotone for any gamma > 0 and ease ∈ [0,1], and defined for every input, so
 * a pressure of exactly 0 or 1 is never special.
 */
export interface PressureCurve {
  /** Output at pressure 0. */
  readonly from: number;
  /** Output at pressure 1. */
  readonly to: number;
  readonly gamma: number;
  /** 0..1 blend toward an S-curve. */
  readonly ease?: number;
}

export function pressureCurve(pressure: number, c: PressureCurve): number {
  let t = clamp01(pressure);
  if (c.gamma !== 1) t = Math.pow(t, c.gamma);
  const e = c.ease ?? 0;
  if (e > 0) t = mix(t, t * t * t * (t * (t * 6 - 15) + 10), e);
  return c.from + (c.to - c.from) * t;
}

/** Sample a curve, for drawing it in the panel. */
export function sampleCurve(c: PressureCurve, n = 24): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(pressureCurve(i / (n - 1), c));
  return out;
}
