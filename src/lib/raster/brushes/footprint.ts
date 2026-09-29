/**
 * Analytic brush footprints.
 *
 * A footprint is a function K(x, y) ∈ [0, 1] evaluated at any sub-pixel
 * position. Nothing is pre-rendered, cached as a bitmap or resampled: a soft
 * round brush, a soft rectangle and a pressure-swelled tip are the same code
 * with different numbers, and each is exact at every position and size.
 *
 * SOFT = CORE ⊕ FALLOFF. A footprint is a mathematically clean core shape (a
 * disc or a rectangle) plus a smooth falloff of the DISTANCE from that core:
 *
 *     K(p) = F( dist(p, core) / softness )
 *
 * Because `dist` is Euclidean, the falloff contours around a rectangle are its
 * offset curves — straight along the sides and circular arcs at the corners.
 * That is what keeps a soft rectangle's geometry clean while its corners stay
 * physically soft: there is no mitred crease, no "digital square corner" and
 * no seam along the diagonals, which is what falloff computed from
 * max(|x|, |y|) produces.
 */

import { clamp01 } from "./curves";

/* ------------------------------------------------------------------ */
/*  falloff                                                            */
/* ------------------------------------------------------------------ */

/**
 * Bell exponent. exp(−K·u²) is the Gaussian bell: the smoothest possible
 * falloff, and the one whose sum along a path has no ripple. Along a stroke the
 * dabs are copies of the kernel shifted by their spacing; by Poisson summation
 * the ripple of such a sum falls off like exp(−2π²σ²/spacing²), which for the
 * spacing used here (≤ one σ) is below 1e-8 — invisible at any bit depth. A
 * smoothstep falloff has only algebraic decay and would band.
 */
const BELL_K = 4.6;
const BELL_E0 = Math.exp(-BELL_K);
const BELL_NORM = 1 / (1 - BELL_E0);

/**
 * F(u): 1 at u = 0, exactly 0 at u = 1, C¹ at the centre. The tiny offset that
 * pins it to zero at u = 1 (≈ 1%) is what gives the kernel finite support,
 * so a dab only ever touches its own bounding box.
 */
export function bell(u: number): number {
  if (u >= 1) return 0;
  if (u <= 0) return 1;
  return (Math.exp(-BELL_K * u * u) - BELL_E0) * BELL_NORM;
}

/** ∫₀¹ bell(u) du — used to normalize deposit against footprint size. */
export const BELL_INTEGRAL = (() => {
  const n = 2000;
  let s = 0;
  for (let i = 0; i < n; i++) s += bell((i + 0.5) / n);
  return s / n;
})();

/* ------------------------------------------------------------------ */
/*  footprint                                                          */
/* ------------------------------------------------------------------ */

export interface Footprint {
  readonly shape: "round" | "rect";
  readonly cx: number;
  readonly cy: number;
  /** cos/sin of the rotation angle. */
  readonly cos: number;
  readonly sin: number;
  /** Semi-axes in the footprint's own frame (round: ellipse radii). */
  readonly hx: number;
  readonly hy: number;
  /**
   * round: fraction of the radius that is fully "on" (0 = pure bell).
   * rect:  unused.
   */
  readonly plateau: number;
  /** rect: width of the soft perimeter, px. round: unused. */
  readonly soft: number;
  /** Half-size of a square that contains the whole footprint. */
  readonly reach: number;
}

export function roundFootprint(
  cx: number, cy: number, rx: number, ry: number, angle: number, plateau: number
): Footprint {
  return {
    shape: "round", cx, cy,
    cos: Math.cos(angle), sin: Math.sin(angle),
    hx: rx, hy: ry,
    plateau: plateau < 0 ? 0 : plateau > 0.95 ? 0.95 : plateau,
    soft: 0,
    reach: Math.max(rx, ry),
  };
}

export function rectFootprint(
  cx: number, cy: number, hx: number, hy: number, angle: number, soft: number
): Footprint {
  const s = Math.max(0.25, Math.min(soft, Math.min(hx, hy)));
  return {
    shape: "rect", cx, cy,
    cos: Math.cos(angle), sin: Math.sin(angle),
    hx, hy, plateau: 0, soft: s,
    // corners are rounded, so the true extent is the rectangle's bounds
    reach: Math.hypot(hx, hy),
  };
}

/** Footprint value at a point, in [0, 1]. */
export function kernel(f: Footprint, x: number, y: number): number {
  const dx = x - f.cx, dy = y - f.cy;
  // world → footprint frame: rotate by −angle
  const lx = dx * f.cos + dy * f.sin;
  const ly = -dx * f.sin + dy * f.cos;

  if (f.shape === "round") {
    const nx = lx / f.hx, ny = ly / f.hy;
    const rho = Math.sqrt(nx * nx + ny * ny);
    if (rho >= 1) return 0;
    const p = f.plateau;
    return bell(rho <= p ? 0 : (rho - p) / (1 - p));
  }

  const qx = Math.abs(lx) - (f.hx - f.soft);
  const qy = Math.abs(ly) - (f.hy - f.soft);
  const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0;
  const dist = Math.sqrt(ox * ox + oy * oy);
  return dist >= f.soft ? 0 : bell(dist / f.soft);
}

/**
 * ∫ K along a line through the centre in world direction (dirX, dirY): the
 * "chord integral". A stroke moving in that direction deposits, at its
 * centreline, weight × this value — so dividing the deposit rate by it makes
 * one pass leave the same density at the centre whatever the brush size,
 * shape or direction of travel. Without it, a wide rectangle dragged
 * sideways would paint several times lighter than the same rectangle dragged
 * lengthways.
 */
export function chordIntegral(f: Footprint, dirX: number, dirY: number): number {
  const n = 24;
  const half = f.reach;
  const step = (2 * half) / n;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const t = -half + (i + 0.5) * step;
    sum += kernel(f, f.cx + dirX * t, f.cy + dirY * t);
  }
  return Math.max(1e-6, sum * step);
}

/** Pixel bounds of a footprint plus a margin, clipped to the surface. */
export function footprintBounds(
  f: Footprint, w: number, h: number, pad = 1
): { x0: number; y0: number; x1: number; y1: number } | null {
  const r = f.reach + pad;
  const x0 = Math.max(0, Math.floor(f.cx - r));
  const y0 = Math.max(0, Math.floor(f.cy - r));
  const x1 = Math.min(w, Math.ceil(f.cx + r));
  const y1 = Math.min(h, Math.ceil(f.cy + r));
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}

/**
 * Anti-aliasing for footprints narrower than a couple of pixels.
 *
 * A kernel sampled at pixel centres aliases when it is narrower than about a
 * pixel: the deposit pulses as the dab crosses pixel boundaries. Averaging the
 * kernel over the pixel's area (a box filter) is the exact cure, and for a
 * bell the box-filtered kernel is very nearly another bell whose variance is
 * larger by 1/12 px². So a small radius is widened by exactly that variance
 * (the bell's σ is 0.33·r, so r² grows by (1/12)/0.33² ≈ 0.76), the effect
 * fades out smoothly by 2.5 px where sampling is already clean, and the
 * amplitude is scaled by r/r′ so the mass deposited across the stroke is
 * conserved.
 */
const PIXEL_VARIANCE_R2 = 0.76;

export function pixelSafeRadius(r: number): { radius: number; gain: number } {
  const t = clamp01((r - 1) / 1.5);
  const fade = t * t * (3 - 2 * t);
  const w = PIXEL_VARIANCE_R2 * (1 - fade);
  if (w <= 1e-6) return { radius: r, gain: 1 };
  const widened = Math.sqrt(r * r + w);
  return { radius: widened, gain: r / widened };
}
