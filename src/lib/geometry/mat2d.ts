/**
 * 2×3 affine algebra.
 *
 * Column-vector convention: matMul(A, B) applies B first, then A.
 * Every transform in the layer system is built from, and decomposed back into,
 * the functions here. There is no second implementation anywhere.
 */

import type { Mat2D, Vec2 } from "@/types/geometry";
import { EPS, MAX_SCALE, MIN_SCALE } from "@/types/geometry";
import { clamp, nearly } from "./scalar";
import { normalizeAngle } from "./angle";

export const MAT_IDENTITY: Mat2D = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export const mat = (
  a: number,
  b: number,
  c: number,
  d: number,
  e: number,
  f: number
): Mat2D => ({ a, b, c, d, e, f });

export const matTranslate = (tx: number, ty: number): Mat2D =>
  ({ a: 1, b: 0, c: 0, d: 1, e: tx, f: ty });

export const matScale = (sx: number, sy: number = sx): Mat2D =>
  ({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });

/** Rotation by `deg`, clockwise-positive in a y-down space (screen/canvas). */
export function matRotate(deg: number): Mat2D {
  const r = (deg * Math.PI) / 180;
  // Exact at the four cardinal angles: Math.sin(Math.PI) is 1.2e-16, not 0,
  // and that noise survives into every bound and hit test if not removed.
  const cos = cardinalCos(deg, Math.cos(r));
  const sin = cardinalSin(deg, Math.sin(r));
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

function cardinalCos(deg: number, fallback: number): number {
  const n = normalizeAngle(deg);
  if (n === 0) return 1;
  if (n === 90 || n === 270) return 0;
  if (n === 180) return -1;
  return fallback;
}

function cardinalSin(deg: number, fallback: number): number {
  const n = normalizeAngle(deg);
  if (n === 0 || n === 180) return 0;
  if (n === 90) return 1;
  if (n === 270) return -1;
  return fallback;
}

/** C = A · B  — B applies first. */
export function matMul(A: Mat2D, B: Mat2D): Mat2D {
  return {
    a: A.a * B.a + A.c * B.b,
    b: A.b * B.a + A.d * B.b,
    c: A.a * B.c + A.c * B.d,
    d: A.b * B.c + A.d * B.d,
    e: A.a * B.e + A.c * B.f + A.e,
    f: A.b * B.e + A.d * B.f + A.f,
  };
}

/** Left-to-right chaining helper: matChain(P, Q, R) === P·Q·R. */
export const matChain = (...ms: readonly Mat2D[]): Mat2D =>
  ms.reduce((acc, m) => matMul(acc, m), MAT_IDENTITY);

export const matDet = (m: Mat2D): number => m.a * m.d - m.b * m.c;

export const matIsInvertible = (m: Mat2D): boolean =>
  Number.isFinite(matDet(m)) && Math.abs(matDet(m)) > EPS;

/** Exact inverse, or null when singular. Callers MUST handle null: a silent
 *  identity fallback turns an un-invertible layer into a layer that accepts
 *  every click, which is far harder to diagnose than a no-op. */
export function matInvert(m: Mat2D): Mat2D | null {
  const det = matDet(m);
  if (!Number.isFinite(det) || Math.abs(det) <= EPS) return null;
  const id = 1 / det;
  return {
    a: m.d * id,
    b: -m.b * id,
    c: -m.c * id,
    d: m.a * id,
    e: (m.c * m.f - m.d * m.e) * id,
    f: (m.b * m.e - m.a * m.f) * id,
  };
}

/** Apply to a point (translation included). */
export const matApply = (m: Mat2D, p: Vec2): Vec2 => ({
  x: m.a * p.x + m.c * p.y + m.e,
  y: m.b * p.x + m.d * p.y + m.f,
});

/** Apply to a direction/delta (translation EXCLUDED). Using matApply on a
 *  delta is the classic bug that makes drags jump by the layer offset. */
export const matApplyVector = (m: Mat2D, v: Vec2): Vec2 => ({
  x: m.a * v.x + m.c * v.y,
  y: m.b * v.x + m.d * v.y,
});

export const matEquals = (A: Mat2D, B: Mat2D, tol: number = EPS): boolean =>
  nearly(A.a, B.a, tol) &&
  nearly(A.b, B.b, tol) &&
  nearly(A.c, B.c, tol) &&
  nearly(A.d, B.d, tol) &&
  nearly(A.e, B.e, tol) &&
  nearly(A.f, B.f, tol);

/** Conjugate a transform into another space: given M expressed in space S and
 *  S→T given by `basis`, return the equivalent transform in T. */
export const matConjugate = (basis: Mat2D, m: Mat2D): Mat2D | null => {
  const inv = matInvert(basis);
  return inv ? matChain(basis, m, inv) : null;
};

/* ---------------- decomposition ---------------- */

export interface Decomposition {
  readonly translation: Vec2;
  /** Degrees, normalized to [0, 360). */
  readonly rotation: number;
  readonly scale: Vec2;
  /** Shear along x after scaling, in degrees. 0 for all TRS matrices. */
  readonly skewX: number;
  /** True when det < 0, i.e. the matrix contains a reflection. Folded into
   *  scale.y so that rotation stays a proper rotation. */
  readonly flipped: boolean;
}

/**
 * QR (Gram–Schmidt) decomposition into T · R · Shear · S.
 *
 * Why QR and not the "atan2(b,a) + hypot" shortcut: the shortcut silently
 * reports a shear as a rotation, so a matrix produced by non-uniform scaling
 * of an already-rotated layer decomposes into a pose that does NOT reproduce
 * the matrix. QR reproduces it exactly, and reports the shear separately so
 * the transform tools can refuse to create one.
 */
export function matDecompose(m: Mat2D): Decomposition {
  const translation: Vec2 = { x: m.e, y: m.f };

  let sx = Math.hypot(m.a, m.b);
  const rotSin = sx > EPS ? m.b / sx : 0;
  const rotCos = sx > EPS ? m.a / sx : 1;

  // Shear = projection of the second basis vector onto the first.
  const shear = rotCos * m.c + rotSin * m.d;
  const sy = Math.hypot(m.c - rotCos * shear, m.d - rotSin * shear);

  const det = matDet(m);
  const flipped = det < 0;

  const rotation = normalizeAngle((Math.atan2(rotSin, rotCos) * 180) / Math.PI);
  const skewX =
    sy > EPS ? (Math.atan2(shear, sy) * 180) / Math.PI : 0;

  if (flipped) sx = -sx; // reflection folded into x, keeping R proper

  return {
    translation,
    rotation,
    scale: { x: sx, y: sy },
    skewX,
    flipped,
  };
}

/** Rebuild from a decomposition. matRecompose(matDecompose(M)) ≈ M for any
 *  invertible M — asserted in tests/geometry/roundtrip.test.ts. */
export function matRecompose(d: Decomposition): Mat2D {
  const shear = Math.tan((d.skewX * Math.PI) / 180);
  const shearMat: Mat2D = { a: 1, b: 0, c: shear, d: 1, e: 0, f: 0 };
  return matChain(
    matTranslate(d.translation.x, d.translation.y),
    matRotate(d.rotation),
    shearMat,
    matScale(d.scale.x, d.scale.y)
  );
}

/** Clamp a scale pair into the legal, invertible range while preserving sign. */
export function clampScale(s: Vec2): Vec2 {
  const fix = (v: number): number => {
    const sign = v < 0 ? -1 : 1;
    const mag = clamp(Math.abs(v) || MIN_SCALE, MIN_SCALE, MAX_SCALE);
    return sign * mag;
  };
  return { x: fix(s.x), y: fix(s.y) };
}

/** Feed a Mat2D straight to a 2D context. Single place that touches the DOM. */
export function matSetTransform(
  ctx: CanvasRenderingContext2D,
  m: Mat2D
): void {
  ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
}
