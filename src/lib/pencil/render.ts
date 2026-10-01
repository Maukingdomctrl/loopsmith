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
 *
 * Ink strokes (Hard Linework) share the same ribbon and edges, but take width
 * and opacity from their material's pressure curves, ignore tilt and speed,
 * and only touch the paper tooth when the material has grain.
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
import { pressureCurve } from "@/lib/raster/brushes/curves";
import { MATERIALS as HARD_MATERIALS, grainedInk } from "@/lib/raster/brushes/models/hard";

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

/** Thinnest ink line, in output px: a feather-light touch stays a hairline. */
const INK_HAIRLINE = 0.15;

const hardMaterial = (stroke: PencilStroke) =>
  HARD_MATERIALS[stroke.material ?? "pen"] ?? HARD_MATERIALS.pen;

/** Pressure → fraction of the stroke's full radius. */
const widthOf = (stroke: PencilStroke) => {
  if (stroke.kind !== "ink") return widthFactor;
  const mat = hardMaterial(stroke);
  return (p: number) => pressureCurve(p, mat.width);
};

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
interface Ribbon {
  n: number;
  x: Float64Array;
  y: Float64Array;
  r: Float64Array; //     radius before tilt, output px
  tilt: Float64Array;
  ux: Float64Array; //    lean direction, output space
  uy: Float64Array;
  dens: Float64Array; //  graphite density / eraser strength
  reach: Float64Array; // how deep into the tooth it deposits
  span: Int32Array; //    input sample the point was built from (its span start)
}

function strokeSamples(stroke: PencilStroke) {
  return Math.floor(stroke.pts.length / PENCIL_STRIDE);
}

/** Per-sample speed in layer px / ms, from neighbouring samples. */
function speeds(pts: readonly number[], n: number): Float64Array {
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1) * PENCIL_STRIDE;
    const b = Math.min(n - 1, i + 1) * PENCIL_STRIDE;
    const dt = Math.max(4, pts[b + P_TIME] - pts[a + P_TIME]);
    v[i] = Math.hypot(pts[b + P_X] - pts[a + P_X], pts[b + P_Y] - pts[a + P_Y]) / dt;
  }
  return v;
}

/** Uniform Catmull-Rom on a scalar — smooth, passes through the samples. */
const crScalar = (p0: number, p1: number, p2: number, p3: number, t: number) =>
  0.5 *
  (2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);

/** Ink smoothing, in multiples of the stroke's full radius: the centre line
 *  lightly (keeps corners), pressure strongly (a pen's pressure readings are
 *  noisy, and the width curve would turn that noise into a lumpy edge). */
const INK_SMOOTH = 1.5;
const INK_PRESSURE_SMOOTH = 6;
/** Least pressure smoothing, in layer px, so fine lines get it too. */
const INK_PRESSURE_SMOOTH_MIN = 8;

/**
 * Arc-length Gaussian smoothing of `values` along a stroke, in place. The
 * window is symmetric (no lag) and shrinks to the distance from each end, so
 * the first and last samples stay put.
 */
function smoothAlong(s: Float64Array, n: number, sigma: number, values: Float64Array[]) {
  if (!(sigma > 0.25)) return;
  const L = s[n - 1];
  const out = values.map(() => new Float64Array(n));
  const acc = new Float64Array(values.length);
  for (let i = 0; i < n; i++) {
    const sg = Math.min(sigma, s[i], L - s[i]);
    if (sg < 1e-3) {
      values.forEach((v, k) => (out[k][i] = v[i]));
      continue;
    }
    const reach = 2.5 * sg, inv = 1 / (2 * sg * sg);
    acc.fill(0);
    let wt = 0;
    for (let j = i; j >= 0 && s[i] - s[j] <= reach; j--) {
      const d = s[i] - s[j], w = Math.exp(-d * d * inv);
      for (let k = 0; k < values.length; k++) acc[k] += values[k][j] * w;
      wt += w;
    }
    for (let j = i + 1; j < n && s[j] - s[i] <= reach; j++) {
      const d = s[j] - s[i], w = Math.exp(-d * d * inv);
      for (let k = 0; k < values.length; k++) acc[k] += values[k][j] * w;
      wt += w;
    }
    for (let k = 0; k < values.length; k++) out[k][i] = acc[k] / wt;
  }
  values.forEach((v, k) => v.set(out[k]));
}

/** Smooth an ink stroke's centre line and pressure (output-space samples). */
/** Ink smoothing widths in output px, for a matrix of this scale. */
function inkSigmas(stroke: PencilStroke, scale: number) {
  return {
    line: INK_SMOOTH * stroke.size * scale,
    pressure: Math.max(INK_PRESSURE_SMOOTH * stroke.size, INK_PRESSURE_SMOOTH_MIN) * scale,
  };
}

function smoothInk(
  X: Float64Array, Y: Float64Array, P: Float64Array, n: number,
  sigmaLine: number, sigmaPressure: number
) {
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1]);
  smoothAlong(s, n, sigmaPressure, [P]);
  smoothAlong(s, n, sigmaLine, [X, Y]);
}

function buildRibbon(stroke: PencilStroke, m: Mat2D): Ribbon {
  const pts = stroke.pts;
  const n = strokeSamples(stroke);
  const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
  const erase = stroke.kind === "erase";
  const ink = stroke.kind === "ink";
  const mat = hardMaterial(stroke);
  const wf = widthOf(stroke);

  // Samples in output space.
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  const P = new Float64Array(n);
  const T = new Float64Array(n);
  const UX = new Float64Array(n);
  const UY = new Float64Array(n);
  const S = speeds(pts, n);
  for (let i = 0; i < n; i++) {
    const o = i * PENCIL_STRIDE;
    const q = matApply(m, { x: pts[o + P_X], y: pts[o + P_Y] });
    X[i] = q.x;
    Y[i] = q.y;
    P[i] = pts[o + P_PRESSURE];
    T[i] = pts[o + P_TILT];
    const az = pts[o + P_AZIMUTH];
    const lx = Math.cos(az);
    const ly = Math.sin(az);
    const dx = m.a * lx + m.c * ly;
    const dy = m.b * lx + m.d * ly;
    const len = Math.hypot(dx, dy) || 1;
    UX[i] = dx / len;
    UY[i] = dy / len;
  }

  if (ink && n > 2) {
    const sg = inkSigmas(stroke, scale);
    smoothInk(X, Y, P, n, sg.line, sg.pressure);
  }

  const out: Ribbon = {
    n: 0,
    x: new Float64Array(64), y: new Float64Array(64), r: new Float64Array(64),
    tilt: new Float64Array(64), ux: new Float64Array(64), uy: new Float64Array(64),
    dens: new Float64Array(64), reach: new Float64Array(64), span: new Int32Array(64),
  };
  let curSpan = 0;
  const grow = () => {
    const cap = out.x.length * 2;
    for (const k of ["x", "y", "r", "tilt", "ux", "uy", "dens", "reach"] as const) {
      const next = new Float64Array(cap);
      next.set(out[k]);
      out[k] = next;
    }
    const span = new Int32Array(cap);
    span.set(out.span);
    out.span = span;
  };
  const push = (x: number, y: number, p: number, tilt: number, ux: number, uy: number, v: number) => {
    if (out.n === out.x.length) grow();
    const pc = Math.min(1, Math.max(0, p));
    const tl = ink ? 0 : Math.min(1, Math.max(0, tilt));
    const slow = Math.exp(-Math.max(0, v) / SPEED_REF);
    const k = out.n++;
    out.span[k] = curSpan;
    out.x[k] = x;
    out.y[k] = y;
    out.r[k] = stroke.size * scale * wf(pc);
    if (ink) out.r[k] = Math.max(INK_HAIRLINE, out.r[k]);
    out.tilt[k] = tl;
    const ul = Math.hypot(ux, uy) || 1;
    out.ux[k] = ux / ul;
    out.uy[k] = uy / ul;
    if (ink) {
      out.dens[k] = Math.min(1, Math.max(0, pressureCurve(pc, mat.opacity))) * (stroke.opacity ?? 1);
      out.reach[k] = 1;
    } else if (erase) {
      out.dens[k] = 0.25 + 0.65 * Math.pow(pc, 1.2);
      out.reach[k] = 0.9;
    } else {
      out.dens[k] = Math.min(1, (0.04 + 0.96 * Math.pow(pc, 1.8)) * (0.85 + 0.25 * slow) * (1 - 0.35 * tl));
      out.reach[k] = Math.min(1, Math.max(0.05, 0.12 + 0.72 * Math.pow(pc, 1.2) + 0.15 * slow - 0.2 * tl));
    }
  };

  if (n === 1) {
    push(X[0], Y[0], P[0], T[0], UX[0], UY[0], 0);
    return out;
  }

  const idx = (i: number) => Math.min(n - 1, Math.max(0, i));
  for (let i = 0; i < n - 1; i++) {
    curSpan = i;
    const i0 = idx(i - 1), i1 = i, i2 = i + 1, i3 = idx(i + 2);
    const span = Math.hypot(X[i2] - X[i1], Y[i2] - Y[i1]);
    const rMin = Math.min(stroke.size * scale * wf(P[i1]), stroke.size * scale * wf(P[i2]));
    const step = Math.max(0.5, Math.min(3, 0.6 * rMin));
    const steps = Math.min(2048, Math.max(1, Math.ceil(span / step)));

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
      push(
        cr(X[i0], X[i1], X[i2], X[i3]),
        cr(Y[i0], Y[i1], Y[i2], Y[i3]),
        crScalar(P[i0], P[i1], P[i2], P[i3], f),
        crScalar(T[i0], T[i1], T[i2], T[i3], f),
        UX[i1] + (UX[i2] - UX[i1]) * f,
        UY[i1] + (UY[i2] - UY[i1]) * f,
        S[i1] + (S[i2] - S[i1]) * f
      );
    }
  }
  const last = n - 1;
  curSpan = last;
  push(X[last], Y[last], P[last], T[last], UX[last], UY[last], S[last]);
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

interface Shader {
  readonly ink: boolean;
  readonly erase: boolean;
  readonly inkGrain: number;
  toothAt(gx: number, gy: number): number;
  inClip(gx: number, gy: number): boolean;
}

function shader(stroke: PencilStroke, opts: RenderOptions, inv: Mat2D, lod: number): Shader {
  const tooth = toothMap(stroke.seed, opts.matrix, opts.surfaceW, opts.surfaceH);
  const ink = stroke.kind === "ink";
  return {
    ink,
    erase: stroke.kind === "erase",
    inkGrain: ink ? hardMaterial(stroke).grain : 0,
    toothAt(gx, gy) {
      const ti = gy * opts.surfaceW + gx;
      let t = tooth[ti];
      if (t < 0) {
        const l = matApply(inv, { x: gx + 0.5, y: gy + 0.5 });
        t = paperTooth(l.x, l.y, stroke.seed, lod);
        tooth[ti] = t;
      }
      return t;
    },
    inClip(gx, gy) {
      const c = opts.clip;
      if (!c) return true;
      const l = matApply(inv, { x: gx + 0.5, y: gy + 0.5 });
      return l.x >= c.x && l.y >= c.y && l.x < c.x + c.w && l.y < c.y + c.h;
    },
  };
}

/**
 * Coverage of ribbon segments [k0, k1) — MAX-combined into `cov`, which covers
 * output pixels [bx0, bx1) × [by0, by1) with row stride `bw`.
 */
function rasterize(
  rib: Ribbon, k0: number, k1: number, sh: Shader,
  cov: Float32Array, bx0: number, by0: number, bw: number, bx1: number, by1: number
): void {
  const { ink, erase, inkGrain } = sh;
  for (let k = k0; k < k1; k++) {
    const a = k;
    const e = rib.n === 1 ? 0 : k + 1;
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
    const px0 = Math.max(bx0, Math.floor(Math.min(ax, ex) - reachOut));
    const py0 = Math.max(by0, Math.floor(Math.min(ay, ey) - reachOut));
    const px1 = Math.min(bx1, Math.ceil(Math.max(ax, ex) + reachOut));
    const py1 = Math.min(by1, Math.ceil(Math.max(ay, ey) + reachOut));

    for (let gy = py0; gy < py1; gy++) {
      const cy = gy + 0.5;
      for (let gx = px0; gx < px1; gx++) {
        const cx = gx + 0.5;
        const sdf = sdTaperedCapsule(cx, cy, ax, ay, ex, ey, rA, rB);
        if (sdf >= 0.5) continue;

        const t = len2 > 1e-12 ? Math.min(1, Math.max(0, ((cx - ax) * dx + (cy - ay) * dy) / len2)) : 0;
        const thin = fA + (fB - fA) * t;
        const dens = rib.dens[a] + (rib.dens[e] - rib.dens[a]) * t;
        let body: number;
        if (ink) {
          body = inkGrain > 0 ? grainedInk(dens, sh.toothAt(gx, gy), inkGrain) : dens;
        } else {
          const reach = rib.reach[a] + (rib.reach[e] - rib.reach[a]) * t;
          const threshold = 1 - reach;
          const caught = smoothstep(threshold - 0.1, threshold + 0.1, sh.toothAt(gx, gy));
          body = dens * (erase ? 0.65 + 0.35 * caught : 0.06 + 0.94 * caught);
        }

        const val = smoothstep(-0.5, 0.5, -sdf) * thin * body;
        const ci = (gy - by0) * bw + (gx - bx0);
        if (val > cov[ci]) cov[ci] = val;
      }
    }
  }
}

/** Output-space extent of ribbon segments [k0, k1), padded for anti-aliasing. */
function segmentsBounds(rib: Ribbon, k0: number, k1: number): IntRect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const last = rib.n === 1 ? 0 : k1;
  for (let i = k0; i <= Math.min(last, rib.n - 1); i++) {
    const pad = rib.r[i] * (1 + TILT_STRETCH) + 2;
    x0 = Math.min(x0, rib.x[i] - pad); y0 = Math.min(y0, rib.y[i] - pad);
    x1 = Math.max(x1, rib.x[i] + pad); y1 = Math.max(y1, rib.y[i] + pad);
  }
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x0: Math.floor(x0), y0: Math.floor(y0), x1: Math.ceil(x1), y1: Math.ceil(y1) };
}

/**
 * The stroke being drawn, rendered incrementally.
 *
 * Re-rendering the whole live stroke every frame costs more the longer the
 * stroke gets, so the line falls behind the pen. Only the end of a stroke can
 * still change (new samples, the spline's look-ahead, ink smoothing), so the
 * part behind it is rendered ONCE into `frozen` and each frame re-renders only
 * the tail. The result is exactly what a full render would give.
 *
 * `update()` returns the changed region as straight RGBA: the stroke colour
 * with alpha = coverage (an erase stroke's alpha is how much it removes).
 */
export class LiveStrokeRaster {
  private readonly frozen: Float32Array;
  private frozenSegs = 0;
  private prevBox: IntRect | null = null;
  private readonly rgb: [number, number, number];

  constructor(readonly stroke: PencilStroke, readonly opts: RenderOptions) {
    this.frozen = new Float32Array(opts.surfaceW * opts.surfaceH);
    this.rgb = parseHex(stroke.color);
  }

  update(): { x0: number; y0: number; w: number; h: number; data: Uint8ClampedArray } | null {
    const { stroke, opts } = this;
    const W = opts.surfaceW, H = opts.surfaceH;
    const n = strokeSamples(stroke);
    if (n === 0) return null;
    const inv = matInvert(opts.matrix);
    if (!inv) return null;
    const m = opts.matrix;
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
    const sh = shader(stroke, opts, inv, scale > 0 ? 1 / scale : 1);
    const rib = buildRibbon(stroke, m);
    const segs = Math.max(1, rib.n - 1);

    // Samples closer to the end than this can still move (ink smoothing).
    let settle = 0;
    if (stroke.kind === "ink") {
      const sg = inkSigmas(stroke, scale);
      settle = 2.5 * Math.max(sg.line, sg.pressure) + 2;
    }
    const pts = stroke.pts;
    let L = 0;
    const arc = new Float64Array(n);
    let px = m.a * pts[P_X] + m.c * pts[P_Y] + m.e;
    let py = m.b * pts[P_X] + m.d * pts[P_Y] + m.f;
    for (let i = 1; i < n; i++) {
      const o = i * PENCIL_STRIDE;
      const qx = m.a * pts[o + P_X] + m.c * pts[o + P_Y] + m.e;
      const qy = m.b * pts[o + P_X] + m.d * pts[o + P_Y] + m.f;
      L += Math.hypot(qx - px, qy - py);
      arc[i] = L;
      px = qx; py = qy;
    }
    let stable = -1;
    while (stable + 1 < n && L - arc[stable + 1] > settle) stable++;
    // A span uses samples up to three ahead (spline look-ahead, speed).
    const stableSpan = stable - 3;
    let fz = this.frozenSegs;
    if (rib.n > 1) while (fz < segs && rib.span[fz + 1] <= stableSpan) fz++;

    if (fz > this.frozenSegs) {
      rasterize(rib, this.frozenSegs, fz, sh, this.frozen, 0, 0, W, W, H);
      this.frozenSegs = fz;
    }

    const tb = segmentsBounds(rib, this.frozenSegs, segs);
    const tail = tb && {
      x0: Math.max(0, tb.x0), y0: Math.max(0, tb.y0),
      x1: Math.min(W, tb.x1), y1: Math.min(H, tb.y1),
    };
    const tailOk = !!tail && tail.x1 > tail.x0 && tail.y1 > tail.y0;
    const tw = tailOk ? tail!.x1 - tail!.x0 : 0;
    const tcov = tailOk ? new Float32Array(tw * (tail!.y1 - tail!.y0)) : null;
    if (tailOk) rasterize(rib, this.frozenSegs, segs, sh, tcov!, tail!.x0, tail!.y0, tw, tail!.x1, tail!.y1);

    let d = tailOk ? { ...tail! } : null;
    const pb = this.prevBox;
    if (pb) {
      d = d
        ? { x0: Math.min(d.x0, pb.x0), y0: Math.min(d.y0, pb.y0), x1: Math.max(d.x1, pb.x1), y1: Math.max(d.y1, pb.y1) }
        : { ...pb };
    }
    this.prevBox = tailOk ? { ...tail! } : null;
    if (!d) return null;

    const w = d.x1 - d.x0, h = d.y1 - d.y0;
    const data = new Uint8ClampedArray(new ArrayBuffer(w * h * 4));
    const [cr, cg, cb] = this.rgb;
    const R = Math.round(cr * 255), G = Math.round(cg * 255), B = Math.round(cb * 255);
    for (let gy = d.y0; gy < d.y1; gy++) {
      for (let gx = d.x0; gx < d.x1; gx++) {
        let a = this.frozen[gy * W + gx];
        if (tailOk && gx >= tail!.x0 && gx < tail!.x1 && gy >= tail!.y0 && gy < tail!.y1) {
          const t = tcov![(gy - tail!.y0) * tw + (gx - tail!.x0)];
          if (t > a) a = t;
        }
        if (a < 1 / 1024 || !sh.inClip(gx, gy)) continue;
        const p = ((gy - d.y0) * w + (gx - d.x0)) * 4;
        data[p] = R; data[p + 1] = G; data[p + 2] = B;
        data[p + 3] = Math.round(a * 255);
      }
    }
    return { x0: d.x0, y0: d.y0, w, h, data };
  }
}

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
  const scale = Math.sqrt(Math.abs(opts.matrix.a * opts.matrix.d - opts.matrix.b * opts.matrix.c));
  const lod = scale > 0 ? 1 / scale : 1;

  for (const stroke of strokes) {
    if (strokeSamples(stroke) === 0) continue;
    const b = strokesBounds([stroke], opts.matrix);
    if (!b) continue;
    const bx0 = Math.max(ox, b.x0, 0);
    const by0 = Math.max(oy, b.y0, 0);
    const bx1 = Math.min(ox + target.width, b.x1, opts.surfaceW);
    const by1 = Math.min(oy + target.height, b.y1, opts.surfaceH);
    if (bx1 <= bx0 || by1 <= by0) continue;

    const bw = bx1 - bx0;
    const cov = new Float32Array(bw * (by1 - by0));
    const sh = shader(stroke, opts, inv, lod);
    const rib = buildRibbon(stroke, opts.matrix);
    rasterize(rib, 0, Math.max(1, rib.n - 1), sh, cov, bx0, by0, bw, bx1, by1);
    const erase = sh.erase;
    const inClip = sh.inClip;

    // Composite the finished stroke once — overlap between strokes builds up.
    const [cr, cg, cb] = parseHex(stroke.color);
    const d = target.data;
    for (let gy = by0; gy < by1; gy++) {
      for (let gx = bx0; gx < bx1; gx++) {
        const a = cov[(gy - by0) * bw + (gx - bx0)];
        if (a < 1 / 1024) continue;
        if (opts.clip && !inClip(gx, gy)) continue;
        const p = ((gy - oy) * target.width + (gx - ox)) * 4;
        const A = d[p + 3] / 255;
        if (stroke.lockAlpha) {
          // Alpha lock: tint what is there, keep its alpha.
          if (erase || A <= 0) continue;
          d[p] = Math.round(cr * 255 * a + d[p] * (1 - a));
          d[p + 1] = Math.round(cg * 255 * a + d[p + 1] * (1 - a));
          d[p + 2] = Math.round(cb * 255 * a + d[p + 2] * (1 - a));
          continue;
        }
        if (erase) {
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
}
