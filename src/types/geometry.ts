/**
 * Geometry primitives for the layer system.
 *
 * ONE matrix convention, everywhere: Mat2D is the same 2×3 affine that
 * CanvasRenderingContext2D.setTransform accepts, in the same order.
 *
 *     | a  c  e |        x' = a·x + c·y + e
 *     | b  d  f |        y' = b·x + d·y + f
 *     | 0  0  1 |
 *
 * Column-vector convention, so (A · B) applies B FIRST. Every compose in this
 * codebase reads right-to-left. Mixing conventions is the single most
 * expensive class of bug in transform code, so there is exactly one.
 */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export interface Mat2D {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

/** Axis-aligned rectangle. `w`/`h` are permitted to be 0 but never negative
 *  after `rectNormalize`. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Four corners in TL, TR, BR, BL order. The image of a Rect under a Mat2D. */
export type Quad = readonly [Vec2, Vec2, Vec2, Vec2];

/* ---------------- tolerances ---------------- */

/**
 * Absolute tolerance for "is this matrix singular / is this angle zero".
 * Chosen at ~1e3·ulp(1) so that a value reconstructed through a
 * compose→invert→compose round trip compares equal, while a genuine 1e-6 px
 * difference does not.
 */
export const EPS = 1e-9;

/** Tolerance for geometry expressed in pixels. Sub-thousandth of a pixel is
 *  below any display or export resolution we support. */
export const PIXEL_EPS = 1e-4;

/** Tolerance for degrees. 1e-6° over a 512 px canvas is ~4.5e-6 px of arc. */
export const ANGLE_EPS = 1e-6;

/** Smallest scale factor a layer may hold. Below this the matrix is
 *  numerically non-invertible and hit-testing becomes meaningless. */
export const MIN_SCALE = 1e-4;
export const MAX_SCALE = 1e4;
