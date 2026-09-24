/**
 * LSA v1.0 — the mutual-support mask and the overlap normalizer.
 *
 * Small module, non-negotiable existence. It owns the denominator of (B.3):
 *
 *     C_ij(u) = Σ m_ij(x,u)‖f_i(x) − f_j(x−u)‖²  /  Σ m_ij(x,u)
 *
 * The paper proves that dropping that denominator is not a minor
 * approximation but a SYSTEMATIC BIAS: the support of m_ij shrinks as ‖u‖
 * grows, mechanically lowering the numerator, so the unnormalized criterion is
 * minimized by MAXIMAL misalignment. Naming the normalizer makes deleting it
 * ("it barely changes") visible in review.
 *
 * Also owns the transparent-pixel and empty-border semantics of §C.4–C.5:
 * a pixel outside the lattice samples as exactly zero support, contributing
 * nothing to M or q, hence introducing no bias.
 */

import type { PixelBox, SignalLevel, SignalPlane } from "./types";

/* ---------- boxes ---------- */

export function boxUnion(a: PixelBox, b: PixelBox): PixelBox {
  if (a.maxX <= a.minX) return b;
  if (b.maxX <= b.minX) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function boxDilate(b: PixelBox, r: number): PixelBox {
  return {
    minX: b.minX - r,
    minY: b.minY - r,
    maxX: b.maxX + r,
    maxY: b.maxY + r,
  };
}

export function boxClamp(b: PixelBox, w: number, h: number): PixelBox {
  return {
    minX: Math.max(0, Math.min(w, b.minX)),
    minY: Math.max(0, Math.min(h, b.minY)),
    maxX: Math.max(0, Math.min(w, b.maxX)),
    maxY: Math.max(0, Math.min(h, b.maxY)),
  };
}

export function boxIsEmpty(b: PixelBox): boolean {
  return b.maxX <= b.minX || b.maxY <= b.minY;
}

/**
 * Region of interest for a pair: the union of both silhouette boxes, dilated by
 * the search radius and clamped to Ω. Restricting the loops to this box is
 * mathematically free (pixels with m_ij = 0 contribute exactly zero to every
 * accumulator, §C.5) and is the difference between ~100 ms and ~30 ms.
 */
export function pairRoi(
  a: SignalLevel,
  b: SignalLevel,
  radius: number
): PixelBox {
  const union = boxUnion(a.supportBox, b.supportBox);
  return boxClamp(boxDilate(union, radius + 2), a.width, a.height);
}

/* ---------- sampling ---------- */

/** Zero-padded bilinear sample of a scalar field. Outside Ω ⇒ exactly 0. */
export function sampleScalar(
  data: Float32Array,
  w: number,
  h: number,
  x: number,
  y: number
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const inX0 = x0 >= 0 && x0 < w;
  const inX1 = x1 >= 0 && x1 < w;
  const inY0 = y0 >= 0 && y0 < h;
  const inY1 = y1 >= 0 && y1 < h;

  const v00 = inX0 && inY0 ? data[y0 * w + x0] : 0;
  const v10 = inX1 && inY0 ? data[y0 * w + x1] : 0;
  const v01 = inX0 && inY1 ? data[y1 * w + x0] : 0;
  const v11 = inX1 && inY1 ? data[y1 * w + x1] : 0;

  const top = v00 + (v10 - v00) * fx;
  const bot = v01 + (v11 - v01) * fx;
  return top + (bot - top) * fy;
}

/** Reusable sample slot; avoids allocating in the IRLS inner loop. */
export interface PlaneSample {
  v: number;
  gx: number;
  gy: number;
}

/**
 * Sample a plane's value and its gradient at a sub-pixel location.
 *
 * Bilinear is provably adequate here: after the σ = 1.2 prefilter of (B.2) the
 * signal is band-limited well below Nyquist, so bilinear's own attenuation is
 * second-order in the residual displacement and — being an isotropic, fixed
 * kernel — introduces no positional bias (Lemma B.1).
 */
export function samplePlane(
  plane: SignalPlane,
  w: number,
  h: number,
  x: number,
  y: number,
  out: PlaneSample
): void {
  out.v = sampleScalar(plane.value, w, h, x, y);
  out.gx = sampleScalar(plane.gx, w, h, x, y);
  out.gy = sampleScalar(plane.gy, w, h, x, y);
}

/**
 * m_ij(x,u) = α_i(x) · α_j(x−u) — the mutual-support mask of (A.1).
 *
 * A product, not a min or a union: a boundary pixel that is half-transparent in
 * one frame and opaque in the other gets weight 0.5, so partially-transparent
 * antialiased silhouette edges cannot dominate the residual the way an
 * alpha-mismatch term would (§C.4).
 */
export function mutualSupport(
  a: SignalLevel,
  b: SignalLevel,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const sa = sampleScalar(a.support, a.width, a.height, ax, ay);
  if (sa <= 0) return 0;
  const sb = sampleScalar(b.support, b.width, b.height, bx, by);
  return sa * sb;
}

/**
 * Overlap-normalized weighted SSD at an INTEGER shift u — (B.3).
 *
 * Integer shift means index arithmetic only: no interpolation, so this is exact
 * and is the cost function whose global minimizer Stage A returns.
 */
export function integerCost(
  a: SignalLevel,
  b: SignalLevel,
  ux: number,
  uy: number,
  roi: PixelBox
): { cost: number; mass: number } {
  const w = a.width;
  const h = a.height;
  const bw = b.width;
  const bh = b.height;

  let num = 0;
  let mass = 0;

  for (let y = roi.minY; y < roi.maxY; y++) {
    const by = y - uy;
    if (by < 0 || by >= bh) continue;
    const rowA = y * w;
    const rowB = by * bw;

    for (let x = roi.minX; x < roi.maxX; x++) {
      const bx = x - ux;
      if (bx < 0 || bx >= bw) continue;

      const ia = rowA + x;
      const ib = rowB + bx;

      const m = a.support[ia] * b.support[ib];
      if (m <= 0) continue;

      const da = a.alpha.value[ia] - b.alpha.value[ib];
      const dl = a.luma.value[ia] - b.luma.value[ib];

      num += m * (da * da + dl * dl);
      mass += m;
    }
  }

  // Empty overlap: report +∞ so argmin never selects a shift that sees nothing.
  return { cost: mass > 0 ? num / mass : Number.POSITIVE_INFINITY, mass };
}
