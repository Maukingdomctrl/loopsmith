/**
 * LSA v1.0 — the bitmap ↔ frame coordinate contract.
 *
 * THIS IS THE HIGHEST-RISK SEAM IN THE FEATURE. It gets its own module and its
 * own test for exactly one reason: the paper solves on the sprite-cell lattice
 * Ω (e.g. 128×128 from sliceSpriteSheet), while Canvas.tsx documents that
 * `frame.x/y` are SCREEN pixels applied BEFORE the scale on a 512×512 canvas
 * ("a pan of 10 moves the image 10 device pixels at any zoom level").
 *
 * Under drawFrameToCanvas the cell is fitted to CANVAS_SIZE, so
 *
 *     1 bitmap px  ==  (CANVAS_SIZE / cellWidth) · zoom   frame units
 *
 * The zoom factor appears because the translate precedes the scale: to move
 * rendered content by one SOURCE pixel you must move it by one source pixel's
 * worth of SCREEN distance, which is the fitted scale times the zoom.
 *
 * Getting this wrong turns a 1.9 px jitter into a 7.6 px correction, silently.
 * Hard-coding the factor at three call sites is how that ships. It lives here.
 */

import type { TranslationVector } from "./types";

/** Matches CANVAS_SIZE in components/Canvas.tsx. Duplicated deliberately:
 *  lib/lsa must not import from components/ (§6.2 dependency inversion).
 *  A unit test asserts the two agree. */
export const LSA_CANVAS_SIZE = 512;

export interface CoordContext {
  /** Width of the source sprite cell in pixels — the lattice Ω of §0. */
  readonly cellWidth: number;
  /** Height of the source sprite cell. Kept for the squareness assertion. */
  readonly cellHeight: number;
  /** frame.zoom at the moment of application. */
  readonly zoom: number;
  /** Override for the fitted scale. Defaults to LSA_CANVAS_SIZE / cellWidth. */
  readonly baseScale?: number;
}

/** (CANVAS_SIZE / cellWidth) · zoom — the one number this module exists for. */
export function bitmapToFrameScale(ctx: CoordContext): number {
  const base = ctx.baseScale ?? LSA_CANVAS_SIZE / ctx.cellWidth;
  return base * ctx.zoom;
}

/** Convert a correction c_i ∈ ℝ² (A.4) from bitmap px into frame.x/y units. */
export function bitmapToFrame(
  v: TranslationVector,
  ctx: CoordContext
): TranslationVector {
  if (v.space !== "bitmap") {
    throw new Error(`bitmapToFrame: expected bitmap space, got ${v.space}`);
  }
  const s = bitmapToFrameScale(ctx);
  return { dx: v.dx * s, dy: v.dy * s, space: "frame" };
}

/** Inverse of bitmapToFrame. Used to read an existing manual nudge back into
 *  the solver's units when reporting, and by the round-trip test. */
export function frameToBitmap(
  v: TranslationVector,
  ctx: CoordContext
): TranslationVector {
  if (v.space !== "frame") {
    throw new Error(`frameToBitmap: expected frame space, got ${v.space}`);
  }
  const s = bitmapToFrameScale(ctx);
  if (!(Math.abs(s) > 0)) return { dx: 0, dy: 0, space: "bitmap" };
  return { dx: v.dx / s, dy: v.dy / s, space: "bitmap" };
}

export function bitmapVector(dx: number, dy: number): TranslationVector {
  return { dx, dy, space: "bitmap" };
}

export function frameVector(dx: number, dy: number): TranslationVector {
  return { dx, dy, space: "frame" };
}

export const ZERO_BITMAP: TranslationVector = { dx: 0, dy: 0, space: "bitmap" };
