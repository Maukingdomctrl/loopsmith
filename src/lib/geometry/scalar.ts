import { EPS, PIXEL_EPS, ANGLE_EPS } from "@/types/geometry";

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Relative-or-absolute comparison. Relative alone fails near zero; absolute
 *  alone fails at canvas-scale magnitudes. */
export function nearly(a: number, b: number, tol: number = EPS): boolean {
  if (a === b) return true;
  const diff = Math.abs(a - b);
  if (diff <= tol) return true;
  return diff <= tol * Math.max(Math.abs(a), Math.abs(b));
}

export const nearlyPx = (a: number, b: number): boolean =>
  nearly(a, b, PIXEL_EPS);

export const nearlyDeg = (a: number, b: number): boolean =>
  nearly(a, b, ANGLE_EPS);

export const isZero = (v: number, tol: number = EPS): boolean =>
  Math.abs(v) <= tol;

export const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Coerce anything that arrived from JSON/localStorage into a usable number. */
export const finiteOr = (v: unknown, fallback: number): number =>
  isFiniteNumber(v) ? v : fallback;

/** Round to a fixed number of decimals without accumulating binary noise.
 *  Used only at UI/persistence boundaries, never inside a solve. */
export function roundTo(v: number, decimals: number): number {
  const p = 10 ** decimals;
  return Math.round(v * p + (v >= 0 ? Number.EPSILON : -Number.EPSILON)) / p;
}
