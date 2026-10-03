/**
 * Analytic pencil renderer.
 *
 * Rebuilds each stroke from its recorded physics at the requested resolution.
 * There are no brush stamps: the stroke's centre line is a centripetal
 * Catmull-Rom spline through the samples, resampled finely in OUTPUT pixels
 * (so it is exactly as smooth at 1% as at 6400%), and every output pixel is
 * shaded from its signed distance to that ribbon:
 *
 *     alpha = smoothstep(-0.5, 0.5, -sdf)
 *
 * The ribbon is a chain of tapered capsules whose radius varies continuously
 * with pressure — width never steps. Lines thinner than a pixel keep a one-
 * pixel footprint and scale their coverage by their true width, so a 0.02 px
 * hairline is a faint, continuous line rather than a broken one.
 *
 * Graphite has three independent behaviours:
 *   width     — pressure (exponential curve) and tilt (footprint);
 *   darkness  — density = pressure^1.8 × grain × dwell; strokes combine as
 *               1 − Π(1 − a), so repeated passes build up gradually;
 *   texture   — graphite catches on the paper's tooth. Light, fast strokes
 *               only touch the peaks; heavy or slow strokes reach the valleys.
 * Within one stroke coverage is the MAX over the ribbon, never a sum, so a
 * stroke does not darken where it overlaps itself.
 */

import type { Mat2D, Rect } from "@/types/geometry";
import { matApply, matInvert } from "@/lib/geometry/mat2d";
import {
  PENCIL_STRIDE,
  P_AZIMUTH,
  P_PRESSURE,
  P_TILT,
  P_TIME,
  P_X,
  P_Y,
  type PencilStroke,
} from "./types";
import { paperTooth } from "./paper";

export interface PixelTarget {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

export interface RenderOptions {
  /** Layer space → output pixel space. */
  readonly matrix: Mat2D;
  /** Full output surface size (the pixel grid the tooth is cached on). */
  readonly surfaceW: number;
  readonly surfaceH: number;
  /** Optional layer-space clip (the layer's crop box). */
  readonly clip: Rect | null;
}

/* ---------------- physics → shading ---------------- */

/** Exponential pressure → width curve: light touch is thin, never zero. */
const WIDTH_K = 1.6;
const WIDTH_NORM = Math.exp(WIDTH_K) - 1;
export const widthFactor = (p: number) =>
  0.35 + 0.65 * ((Math.exp(WIDTH_K * p) - 1) / WIDTH_NORM);

/** Tilt stretches the footprint along the lean direction (side of the lead). */
const TILT_STRETCH = 1.6;
/** Speed (layer px / ms) at which dwell stops adding richness. */
const SPEED_REF = 0.6;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.17, 0.17, 0.17];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/* ---------------- tooth cache ---------------- */

/**
 * Paper height per OUTPUT pixel, computed lazily and kept per (seed, view).
 * The paper is the expensive part of shading and does not change while the
 * view is still, so live drawing only pays for it once per pixel.
 */
const toothMaps = new Map<string, Float32Array>();
const TOOTH_MAPS_MAX = 8;

function toothMap(seed: number, m: Mat2D, w: number, h: number): Float32Array {
  const key = `${seed}|${m.a},${m.b},${m.c},${m.d},${m.e},${m.f}|${w}x${h}`;
  let map = toothMaps.get(key);
  if (map) {
    toothMaps.delete(key);
    toothMaps.set(key, map);
    return map;
  }
  map = new Float32Array(w * h).fill(-1);
  toothMaps.set(key, map);
  if (toothMaps.size > TOOTH_MAPS_MAX) {
    toothMaps.delete(toothMaps.keys().next().value as string);
  }
  return map;
}

/* ---------------- geometry ---------------- */

/**
 * Signed distance to a tapered capsule (round cone) from a to b with radii
 * ra, rb. Exact; after Inigo Quilez's sdUnevenCapsule.
 */
function sdTaperedCapsule(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number,
  ra: number, rb: number
): number {
  px -= ax;
  py -= ay;
  const dx = bx - ax;
  const dy = by - ay;
  const h = dx * dx + dy * dy;
  if (h < 1e-12) return Math.hypot(px, py) - Math.max(ra, rb);
  const b = ra - rb;
  if (b * b >= h) {
    // One end cap swallows the other.
    return Math.min(Math.hypot(px, py) - ra, Math.hypot(px - dx, py - dy) - rb);
  }
  const qx = Math.abs((px * dy - py * dx) / h);
  const qy = (px * dx + py * dy) / h;
  const cx = Math.sqrt(h - b * b);
  const cy = b;
  const k = cx * qy - cy * qx;
  const m = cx * qx + cy * qy;
  const n = qx * qx + qy * qy;
  if (k < 0) return Math.sqrt(h * n) - ra;
  if (k > cx) return Math.sqrt(h * (n + 1 - 2 * qy)) - rb;
  return m - ra;
}

/** Half-width of the tilted elliptical footprint across direction (nx, ny). */
function footprint(r: number, tilt: number, ux: number, uy: number, nx: number, ny: number): number {
  const a = r * (1 + TILT_STRETCH * tilt);
  const du = nx * ux + ny * uy;
  const dv = -nx * uy + ny * ux;
  return Math.sqrt(a * a * du * du + r * r * dv * dv);
}

/** Resampled ribbon, in output pixels. */
class Ribbon {
  n = 0;
  x = new Float64Array(64);
  y = new Float64Array(64);
  r = new Float64Array(64); //     radius before tilt, output px
  tilt = new Float64Array(64);
  ux = new Float64Array(64); //    lean direction, output space
  uy = new Float64Array(64);
  dens = new Float64Array(64); //  graphite density / eraser strength
  reach = new Float64Array(64); // how deep into the tooth it deposits

  add(
    x: number, y: number, r: number, tilt: number,
    ux: number, uy: number, dens: number, reach: number
  ): void {
    if (this.n === this.x.length) {
      const cap = this.x.length * 2;
      for (const k of ["x", "y", "r", "tilt", "ux", "uy", "dens", "reach"] as const) {
        const next = new Float64Array(cap);
        next.set(this[k]);
        this[k] = next;
      }
    }
    const k = this.n++;
    this.x[k] = x;
    this.y[k] = y;
    this.r[k] = r;
    this.tilt[k] = tilt;
    this.ux[k] = ux;
    this.uy[k] = uy;
    this.dens[k] = dens;
    this.reach[k] = reach;
  }

  /** Append point k of another ribbon, as is. */
  copy(from: Ribbon, k: number): void {
    this.add(
      from.x[k], from.y[k], from.r[k], from.tilt[k],
      from.ux[k], from.uy[k], from.dens[k], from.reach[k]
    );
  }
}

function strokeSamples(stroke: PencilStroke) {
  return Math.floor(stroke.pts.length / PENCIL_STRIDE);
}

/**
 * A stroke's samples in output space. Samples only ever append (a stroke
 * being drawn grows), so each is transformed once. Speed is read on demand:
 * the newest sample's depends on the one after it.
 */
class StrokeSamples {
  n = 0;
  readonly X: number[] = [];
  readonly Y: number[] = [];
  readonly P: number[] = [];
  readonly T: number[] = [];
  readonly UX: number[] = [];
  readonly UY: number[] = [];
  readonly stroke: PencilStroke;
  readonly m: Mat2D;
  readonly scale: number;
  readonly erase: boolean;
  /** Padding of the bounds, exactly as `strokesBounds` pads them. */
  readonly pad: number;
  private bx0 = Infinity;
  private by0 = Infinity;
  private bx1 = -Infinity;
  private by1 = -Infinity;

  constructor(stroke: PencilStroke, m: Mat2D) {
    this.stroke = stroke;
    this.m = m;
    this.scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
    this.erase = stroke.kind === "erase";
    this.pad = stroke.size * this.scale * (1 + TILT_STRETCH) + 2;
  }

  /** Take in any samples added since the last call; returns the count. */
  sync(): number {
    const pts = this.stroke.pts;
    const m = this.m;
    const n = strokeSamples(this.stroke);
    for (let i = this.n; i < n; i++) {
      const o = i * PENCIL_STRIDE;
      const q = matApply(m, { x: pts[o + P_X], y: pts[o + P_Y] });
      this.X.push(q.x);
      this.Y.push(q.y);
      this.P.push(pts[o + P_PRESSURE]);
      this.T.push(pts[o + P_TILT]);
      const az = pts[o + P_AZIMUTH];
      const lx = Math.cos(az);
      const ly = Math.sin(az);
      const dx = m.a * lx + m.c * ly;
      const dy = m.b * lx + m.d * ly;
      const len = Math.hypot(dx, dy) || 1;
      this.UX.push(dx / len);
      this.UY.push(dy / len);
      const pad = this.pad;
      if (q.x - pad < this.bx0) this.bx0 = q.x - pad;
      if (q.y - pad < this.by0) this.by0 = q.y - pad;
      if (q.x + pad > this.bx1) this.bx1 = q.x + pad;
      if (q.y + pad > this.by1) this.by1 = q.y + pad;
    }
    this.n = n;
    return n;
  }

  /** Speed at sample i in layer px / ms, from its neighbours. */
  speed(i: number): number {
    const pts = this.stroke.pts;
    const a = Math.max(0, i - 1) * PENCIL_STRIDE;
    const b = Math.min(this.n - 1, i + 1) * PENCIL_STRIDE;
    const dt = Math.max(4, pts[b + P_TIME] - pts[a + P_TIME]);
    return Math.hypot(pts[b + P_X] - pts[a + P_X], pts[b + P_Y] - pts[a + P_Y]) / dt;
  }

  /** The samples' padded output-pixel bounds — the same rect `strokesBounds`
   *  gives for this stroke. */
  bounds(): IntRect | null {
    if (!(this.bx1 > this.bx0 && this.by1 > this.by0)) return null;
    return {
      x0: Math.floor(this.bx0), y0: Math.floor(this.by0),
      x1: Math.ceil(this.bx1), y1: Math.ceil(this.by1),
    };
  }
}

/** Uniform Catmull-Rom on a scalar — smooth, passes through the samples. */
const crScalar = (p0: number, p1: number, p2: number, p3: number, t: number) =>
  0.5 *
  (2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);

/** Shade one ribbon point from the physics there and append it. */
function pushPoint(
  out: Ribbon, smp: StrokeSamples,
  x: number, y: number, p: number, tilt: number, ux: number, uy: number, v: number
): void {
  const pc = Math.min(1, Math.max(0, p));
  const tl = Math.min(1, Math.max(0, tilt));
  const slow = Math.exp(-Math.max(0, v) / SPEED_REF);
  const ul = Math.hypot(ux, uy) || 1;
  let dens: number, reach: number;
  if (smp.erase) {
    dens = 0.25 + 0.65 * Math.pow(pc, 1.2);
    reach = 0.9;
  } else {
    dens = Math.min(1, (0.04 + 0.96 * Math.pow(pc, 1.8)) * (0.85 + 0.25 * slow) * (1 - 0.35 * tl));
    reach = Math.min(1, Math.max(0.05, 0.12 + 0.72 * Math.pow(pc, 1.2) + 0.15 * slow - 0.2 * tl));
  }
  out.add(x, y, smp.stroke.size * smp.scale * widthFactor(pc), tl, ux / ul, uy / ul, dens, reach);
}

/**
 * The ribbon points of span i (sample i → i + 1), without its end point. A
 * span reads samples i − 1 … i + 2, so it is final once sample i + 2 exists.
 */
function pushSpan(out: Ribbon, smp: StrokeSamples, i: number): void {
  const { X, Y, P, T, UX, UY, n } = smp;
  const size = smp.stroke.size, scale = smp.scale;
  const idx = (j: number) => Math.min(n - 1, Math.max(0, j));
  const i0 = idx(i - 1), i1 = i, i2 = i + 1, i3 = idx(i + 2);
  const span = Math.hypot(X[i2] - X[i1], Y[i2] - Y[i1]);
  const rMin = Math.min(size * scale * widthFactor(P[i1]), size * scale * widthFactor(P[i2]));
  const step = Math.max(0.5, Math.min(3, 0.6 * rMin));
  const steps = Math.min(2048, Math.max(1, Math.ceil(span / step)));
  const S1 = smp.speed(i1), S2 = smp.speed(i2);

  // Centripetal Catmull-Rom knots (alpha 0.5): no cusps, no overshoot loops.
  const d01 = Math.max(1e-4, Math.sqrt(Math.hypot(X[i1] - X[i0], Y[i1] - Y[i0])));
  const d12 = Math.max(1e-4, Math.sqrt(span));
  const d23 = Math.max(1e-4, Math.sqrt(Math.hypot(X[i3] - X[i2], Y[i3] - Y[i2])));
  const t0 = 0, t1 = t0 + d01, t2 = t1 + d12, t3 = t2 + d23;

  for (let s = 0; s < steps; s++) {
    const f = s / steps;
    const t = t1 + (t2 - t1) * f;
    const cr = (a0: number, a1: number, a2: number, a3: number) => {
      const A1 = ((t1 - t) * a0 + (t - t0) * a1) / (t1 - t0);
      const A2 = ((t2 - t) * a1 + (t - t1) * a2) / (t2 - t1);
      const A3 = ((t3 - t) * a2 + (t - t2) * a3) / (t3 - t2);
      const B1 = ((t2 - t) * A1 + (t - t0) * A2) / (t2 - t0);
      const B2 = ((t3 - t) * A2 + (t - t1) * A3) / (t3 - t1);
      return ((t2 - t) * B1 + (t - t1) * B2) / (t2 - t1);
    };
    pushPoint(
      out, smp,
      cr(X[i0], X[i1], X[i2], X[i3]),
      cr(Y[i0], Y[i1], Y[i2], Y[i3]),
      crScalar(P[i0], P[i1], P[i2], P[i3], f),
      crScalar(T[i0], T[i1], T[i2], T[i3], f),
      UX[i1] + (UX[i2] - UX[i1]) * f,
      UY[i1] + (UY[i2] - UY[i1]) * f,
      S1 + (S2 - S1) * f
    );
  }
}

/** The stroke's last sample — and, for a single sample, the whole dot. */
function pushEnd(out: Ribbon, smp: StrokeSamples): void {
  const last = smp.n - 1;
  pushPoint(
    out, smp,
    smp.X[last], smp.Y[last], smp.P[last], smp.T[last], smp.UX[last], smp.UY[last],
    smp.n === 1 ? 0 : smp.speed(last)
  );
}

function buildRibbon(smp: StrokeSamples): Ribbon {
  const out = new Ribbon();
  for (let i = 0; i < smp.n - 1; i++) pushSpan(out, smp, i);
  pushEnd(out, smp);
  return out;
}

/* ---------------- bounds ---------------- */

export interface IntRect { x0: number; y0: number; x1: number; y1: number }

/** Output-pixel bounds of strokes (half-open), before clamping. */
export function strokesBounds(strokes: readonly PencilStroke[], m: Mat2D): IntRect | null {
  const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) {
    const n = strokeSamples(s);
    const pad = s.size * scale * (1 + TILT_STRETCH) + 2;
    for (let i = 0; i < n; i++) {
      const o = i * PENCIL_STRIDE;
      const q = matApply(m, { x: s.pts[o + P_X], y: s.pts[o + P_Y] });
      if (q.x - pad < x0) x0 = q.x - pad;
      if (q.y - pad < y0) y0 = q.y - pad;
      if (q.x + pad > x1) x1 = q.x + pad;
      if (q.y + pad > y1) y1 = q.y + pad;
    }
  }
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.ceil(x1), y1: Math.ceil(y1) };
}

/* ---------------- render ---------------- */

/** What shading one stroke in one view needs, besides its ribbon. */
interface Shade {
  readonly stroke: PencilStroke;
  readonly erase: boolean;
  readonly rgb: [number, number, number];
  readonly toothAt: (gx: number, gy: number) => number;
  readonly inClip: (gx: number, gy: number) => boolean;
  readonly clipped: boolean;
}

function shadeFor(stroke: PencilStroke, opts: RenderOptions, inv: Mat2D, lod: number): Shade {
  const tooth = toothMap(stroke.seed, opts.matrix, opts.surfaceW, opts.surfaceH);
  return {
    stroke,
    erase: stroke.kind === "erase",
    rgb: parseHex(stroke.color),
    toothAt: (gx, gy) => {
      const ti = gy * opts.surfaceW + gx;
      let t = tooth[ti];
      if (t < 0) {
        const l = matApply(inv, { x: gx + 0.5, y: gy + 0.5 });
        t = paperTooth(l.x, l.y, stroke.seed, lod);
        tooth[ti] = t;
      }
      return t;
    },
    inClip: (gx, gy) => {
      const c = opts.clip;
      if (!c) return true;
      const l = matApply(inv, { x: gx + 0.5, y: gy + 0.5 });
      return l.x >= c.x && l.y >= c.y && l.x < c.x + c.w && l.y < c.y + c.h;
    },
    clipped: !!opts.clip,
  };
}

/**
 * Coverage of ribbon segment a → e, max-ed into `cov`, which covers
 * [x0, x1) × [y0, y1). Returns the pixels it looked at. Within one stroke
 * coverage is a max, so segments can be laid down in any order, any number of
 * frames apart, and give the same result.
 */
function rasterSegment(
  rib: Ribbon, a: number, e: number, sh: Shade,
  cov: Float32Array, x0: number, y0: number, x1: number, y1: number
): IntRect | null {
  const ax = rib.x[a], ay = rib.y[a], ex = rib.x[e], ey = rib.y[e];
  const dx = ex - ax, dy = ey - ay;
  const len2 = dx * dx + dy * dy;
  const len = Math.sqrt(len2);
  const nx = len > 1e-9 ? -dy / len : 0;
  const ny = len > 1e-9 ? dx / len : 1;

  // True half-widths across the path, including the tilted footprint.
  const hA = footprint(rib.r[a], rib.tilt[a], rib.ux[a], rib.uy[a], nx, ny);
  const hB = footprint(rib.r[e], rib.tilt[e], rib.ux[e], rib.uy[e], nx, ny);
  // Sub-pixel lines: keep a 1 px footprint, scale coverage by true width.
  const rA = Math.max(0.5, hA), rB = Math.max(0.5, hB);
  const fA = Math.min(1, hA * 2), fB = Math.min(1, hB * 2);

  const reachOut = Math.max(rA, rB) + 1;
  const px0 = Math.max(x0, Math.floor(Math.min(ax, ex) - reachOut));
  const py0 = Math.max(y0, Math.floor(Math.min(ay, ey) - reachOut));
  const px1 = Math.min(x1, Math.ceil(Math.max(ax, ex) + reachOut));
  const py1 = Math.min(y1, Math.ceil(Math.max(ay, ey) + reachOut));
  if (px1 <= px0 || py1 <= py0) return null;
  const bw = x1 - x0;

  for (let gy = py0; gy < py1; gy++) {
    const cy = gy + 0.5;
    for (let gx = px0; gx < px1; gx++) {
      const cx = gx + 0.5;
      const sdf = sdTaperedCapsule(cx, cy, ax, ay, ex, ey, rA, rB);
      if (sdf >= 0.5) continue;

      const t = len2 > 1e-12 ? Math.min(1, Math.max(0, ((cx - ax) * dx + (cy - ay) * dy) / len2)) : 0;
      const thin = fA + (fB - fA) * t;
      const dens = rib.dens[a] + (rib.dens[e] - rib.dens[a]) * t;
      const reach = rib.reach[a] + (rib.reach[e] - rib.reach[a]) * t;
      const threshold = 1 - reach;
      const caught = smoothstep(threshold - 0.1, threshold + 0.1, sh.toothAt(gx, gy));
      const grain = sh.erase ? 0.65 + 0.35 * caught : 0.06 + 0.94 * caught;

      const val = smoothstep(-0.5, 0.5, -sdf) * thin * dens * grain;
      const ci = (gy - y0) * bw + (gx - x0);
      if (val > cov[ci]) cov[ci] = val;
    }
  }
  return { x0: px0, y0: py0, x1: px1, y1: py1 };
}

/**
 * Lay a finished stroke's coverage — `cov`, covering [x0, x1) × [y0, y1) —
 * over `target`, which covers output pixels from (ox, oy). Once per stroke:
 * overlap between strokes builds up, overlap within one does not.
 */
function compositeStroke(
  target: PixelTarget, ox: number, oy: number, sh: Shade,
  cov: Float32Array, x0: number, y0: number, x1: number, y1: number
): void {
  const [cr, cg, cb] = sh.rgb;
  const d = target.data;
  const bw = x1 - x0;
  const lockAlpha = sh.stroke.lockAlpha;
  for (let gy = y0; gy < y1; gy++) {
    for (let gx = x0; gx < x1; gx++) {
      const a = cov[(gy - y0) * bw + (gx - x0)];
      if (a < 1 / 1024) continue;
      if (sh.clipped && !sh.inClip(gx, gy)) continue;
      const p = ((gy - oy) * target.width + (gx - ox)) * 4;
      const A = d[p + 3] / 255;
      if (lockAlpha) {
        // Alpha lock: tint what is there, keep its alpha.
        if (sh.erase || A <= 0) continue;
        d[p] = Math.round(cr * 255 * a + d[p] * (1 - a));
        d[p + 1] = Math.round(cg * 255 * a + d[p + 1] * (1 - a));
        d[p + 2] = Math.round(cb * 255 * a + d[p + 2] * (1 - a));
        continue;
      }
      if (sh.erase) {
        d[p + 3] = Math.round(A * (1 - a) * 255);
        continue;
      }
      const Ao = a + A * (1 - a);
      const keep = (A * (1 - a)) / Ao;
      const mix = a / Ao;
      d[p] = Math.round((cr * mix) * 255 + d[p] * keep);
      d[p + 1] = Math.round((cg * mix) * 255 + d[p + 1] * keep);
      d[p + 2] = Math.round((cb * mix) * 255 + d[p + 2] * keep);
      d[p + 3] = Math.round(Ao * 255);
    }
  }
}

const lodOf = (m: Mat2D) => {
  const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  return scale > 0 ? 1 / scale : 1;
};

/**
 * Render `strokes`, in order, into `target`, which covers output pixels
 * [ox, ox + width) × [oy, oy + height). `target` is non-premultiplied RGBA
 * (ImageData layout) and already holds whatever lies beneath — imported art,
 * earlier strokes — so erase strokes remove it too.
 */
export function renderStrokes(
  target: PixelTarget,
  ox: number,
  oy: number,
  strokes: readonly PencilStroke[],
  opts: RenderOptions
): void {
  const inv = matInvert(opts.matrix);
  if (!inv) return;
  const lod = lodOf(opts.matrix);

  for (const stroke of strokes) {
    if (strokeSamples(stroke) === 0) continue;
    const b = strokesBounds([stroke], opts.matrix);
    if (!b) continue;
    const bx0 = Math.max(ox, b.x0, 0);
    const by0 = Math.max(oy, b.y0, 0);
    const bx1 = Math.min(ox + target.width, b.x1, opts.surfaceW);
    const by1 = Math.min(oy + target.height, b.y1, opts.surfaceH);
    if (bx1 <= bx0 || by1 <= by0) continue;

    const cov = new Float32Array((bx1 - bx0) * (by1 - by0));
    const sh = shadeFor(stroke, opts, inv, lod);
    const smp = new StrokeSamples(stroke, opts.matrix);
    smp.sync();
    const rib = buildRibbon(smp);
    const segs = Math.max(1, rib.n - 1);
    for (let k = 0; k < segs; k++) {
      rasterSegment(rib, k, rib.n === 1 ? 0 : k + 1, sh, cov, bx0, by0, bx1, by1);
    }
    compositeStroke(target, ox, oy, sh, cov, bx0, by0, bx1, by1);
  }
}

/* ---------------- live (incremental) render ---------------- */

/** A rect of finished output pixels, ready for `putImageData`. */
export interface PixelPatch {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray<ArrayBuffer>;
}

const intersect = (a: IntRect, b: IntRect): IntRect | null => {
  const r = {
    x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1),
  };
  return r.x1 > r.x0 && r.y1 > r.y0 ? r : null;
};

const union = (a: IntRect | null, b: IntRect | null): IntRect | null =>
  !a ? b : !b ? a : {
    x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
  };

/**
 * A stroke still being drawn, rendered INCREMENTALLY and exactly.
 *
 * Re-rendering the whole stroke every frame costs more the longer it gets (and
 * the denser the screen). Instead, the parts that can no longer change are laid
 * down once: a span of the curve is final as soon as the sample two ahead of
 * it exists (it reads samples i − 1 … i + 2), so its ribbon segments go into a
 * persistent coverage buffer the frame that happens. Only the provisional tail
 * — the last span or two, near the pen — is redone each frame, and only the
 * pixels that changed are composited, from a snapshot of what lies beneath.
 *
 * Coverage within a stroke is a max, which is order-independent, and every
 * piece uses the arithmetic `renderStrokes` uses, over the same bounds, so the
 * last frame is pixel-for-pixel the render the stroke gets once committed.
 */
export class LiveStrokeRender {
  private readonly opts: RenderOptions;
  private readonly beneath: Uint8ClampedArray;
  private readonly smp: StrokeSamples;
  private readonly sh: Shade | null;
  private readonly surface: IntRect;
  /** Ribbon points of the final spans. */
  private readonly fin = new Ribbon();
  private finSpans = 0;
  /** Final segments already in `cov`: those ending at points ≤ drawn. */
  private drawn = 0;
  /** Coverage of the final segments, the whole output surface. */
  private readonly cov: Float32Array;
  /** Last frame's tail area, and the area composited so far. */
  private tail: IntRect | null = null;
  private shown: IntRect | null = null;

  /**
   * @param beneath  The output surface as it is under the stroke: RGBA,
   *                 surfaceW × surfaceH, non-premultiplied (ImageData layout).
   */
  constructor(stroke: PencilStroke, opts: RenderOptions, beneath: Uint8ClampedArray) {
    this.opts = opts;
    this.beneath = beneath;
    this.smp = new StrokeSamples(stroke, opts.matrix);
    const inv = matInvert(opts.matrix);
    this.sh = inv ? shadeFor(stroke, opts, inv, lodOf(opts.matrix)) : null;
    this.surface = { x0: 0, y0: 0, x1: opts.surfaceW, y1: opts.surfaceH };
    this.cov = new Float32Array(opts.surfaceW * opts.surfaceH);
  }

  /** Bring the render up to the stroke's current samples; returns the patches
   *  of output pixels that changed. */
  update(): PixelPatch[] {
    const sh = this.sh;
    const smp = this.smp;
    if (!sh || smp.sync() === 0) return [];
    const n = smp.n;
    const W = this.opts.surfaceW, H = this.opts.surfaceH;
    const dirty: IntRect[] = [];

    // Spans whose four samples are all known: into the coverage, once.
    while (this.finSpans <= n - 3) pushSpan(this.fin, smp, this.finSpans++);
    let fresh: IntRect | null = null;
    for (; this.drawn + 1 < this.fin.n; this.drawn++) {
      fresh = union(fresh, rasterSegment(this.fin, this.drawn, this.drawn + 1, sh, this.cov, 0, 0, W, H));
    }
    if (fresh) dirty.push(fresh);

    // The provisional tail, from the last final point to the pen.
    const tail = new Ribbon();
    if (this.fin.n > 0) tail.copy(this.fin, this.fin.n - 1);
    for (let i = this.finSpans; i <= n - 2; i++) pushSpan(tail, smp, i);
    pushEnd(tail, smp);
    let tx0 = Infinity, ty0 = Infinity, tx1 = -Infinity, ty1 = -Infinity;
    for (let k = 0; k < tail.n; k++) {
      tx0 = Math.min(tx0, tail.x[k]); ty0 = Math.min(ty0, tail.y[k]);
      tx1 = Math.max(tx1, tail.x[k]); ty1 = Math.max(ty1, tail.y[k]);
    }
    const tr = intersect(this.surface, {
      x0: Math.floor(tx0 - smp.pad), y0: Math.floor(ty0 - smp.pad),
      x1: Math.ceil(tx1 + smp.pad), y1: Math.ceil(ty1 + smp.pad),
    });
    let tailCov: Float32Array | null = null;
    if (tr) {
      tailCov = new Float32Array((tr.x1 - tr.x0) * (tr.y1 - tr.y0));
      const segs = Math.max(1, tail.n - 1);
      for (let k = 0; k < segs; k++) {
        rasterSegment(tail, k, tail.n === 1 ? 0 : k + 1, sh, tailCov, tr.x0, tr.y0, tr.x1, tr.y1);
      }
      dirty.push(tr);
    }
    if (this.tail) dirty.push(this.tail);
    this.tail = tr;

    // `renderStrokes` composites exactly the samples' padded bounds; pixels the
    // growing bounds take in show their coverage from now on.
    const b = smp.bounds();
    const shown = b ? intersect(this.surface, b) : null;
    const old = this.shown;
    if (shown) {
      if (!old) dirty.push(shown);
      else {
        dirty.push({ x0: shown.x0, y0: shown.y0, x1: old.x0, y1: shown.y1 });
        dirty.push({ x0: old.x1, y0: shown.y0, x1: shown.x1, y1: shown.y1 });
        dirty.push({ x0: old.x0, y0: shown.y0, x1: old.x1, y1: old.y0 });
        dirty.push({ x0: old.x0, y0: old.y1, x1: old.x1, y1: shown.y1 });
      }
    }
    this.shown = shown;
    if (!shown) return [];

    const patches: PixelPatch[] = [];
    for (const d of dirty) {
      const r = intersect(d, shown);
      if (r) patches.push(this.patch(r, tailCov, tr));
    }
    return patches;
  }

  /** Recomposite one rect from the snapshot: final coverage max the tail's. */
  private patch(r: IntRect, tailCov: Float32Array | null, tr: IntRect | null): PixelPatch {
    const W = this.opts.surfaceW;
    const w = r.x1 - r.x0, h = r.y1 - r.y0;
    const data = new Uint8ClampedArray(new ArrayBuffer(w * h * 4));
    const cov = new Float32Array(w * h);
    const tw = tr ? tr.x1 - tr.x0 : 0;
    for (let y = 0; y < h; y++) {
      const gy = r.y0 + y;
      const src = (gy * W + r.x0) * 4;
      data.set(this.beneath.subarray(src, src + w * 4), y * w * 4);
      const inTail = !!tr && !!tailCov && gy >= tr.y0 && gy < tr.y1;
      for (let x = 0; x < w; x++) {
        const gx = r.x0 + x;
        let c = this.cov[gy * W + gx];
        if (inTail && gx >= tr!.x0 && gx < tr!.x1) {
          const t = tailCov![(gy - tr!.y0) * tw + (gx - tr!.x0)];
          if (t > c) c = t;
        }
        cov[y * w + x] = c;
      }
    }
    compositeStroke({ data, width: w, height: h }, r.x0, r.y0, this.sh!, cov, r.x0, r.y0, r.x1, r.y1);
    return { x: r.x0, y: r.y0, width: w, height: h, data };
  }
}
