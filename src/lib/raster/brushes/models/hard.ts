/**
 * Hard Linework — the precision brush.
 *
 * NOT A STAMP. Nothing here places a disc at each point and hopes the discs
 * merge. The stroke is GEOMETRY: a ribbon whose width is a continuous function
 * of pressure, swept along the curve, and rasterized by exact area:
 *
 *     pressure → continuous diameter (hardTip) → ribbon of round cones
 *              → exact coverage per pixel → composite
 *
 * The curve is the existing arc-length-resampled path. Each pair of consecutive
 * points bounds a "round cone" — the convex hull of two discs of different
 * radii — and the stroke is the union of those cones.
 *
 * COVERAGE IS EXACT, NOT APPROXIMATED BY A DISTANCE RAMP:
 *  - Every pixel is first classified with the cone's exact signed distance:
 *    entirely inside (written as one number), entirely outside (skipped), or
 *    crossed by the edge.
 *  - A crossed pixel is split into 4×4 cells (subpixel.ts). Each cell gets the
 *    exact box-filtered area of the local strip (analytic.ts), so the result
 *    moves continuously with sub-pixel position — a line at x = 100.125 and one
 *    at x = 100.375 cover their pixels differently, as they should.
 *  - Cones are merged with `max` PER CELL, which is a true union to within a
 *    cell. Merging per pixel is what makes thin lines bead at every joint.
 *  - At a joint the span is treated as continuing (the next span carries on
 *    in nearly the same direction); at the TRUE start and end of the stroke the
 *    round cap is integrated exactly. The end is only known when the pen lifts,
 *    so `settle` redraws the last few pixels with an exact cap.
 *
 * "Hard" is the edge: no softening is added anywhere. A hairline and a 48 px
 * line are equally crisp; the only grey on the rim is the exact fraction of
 * each pixel the ink covers.
 */

import type { Rect } from "@/types/geometry";
import { DirtyTracker, RasterSurface } from "../../surface";
import type { BrushInput, BrushModel, ModelContext } from "../types";
import { clamp01, pressureCurve, smoothstep, type PressureCurve } from "../curves";
import { boxCdf, sdRoundCone } from "../analytic";
import { CELL, SUB, SubpixelCoverage } from "../subpixel";
import { paperField } from "../paper";

/* ---------- materials ---------- */

interface HardMaterial {
  /** Pressure → how far the line has opened, 0 = hairline … 1 = full size. */
  readonly width: PressureCurve;
  /** Pressure → opacity of the ink. */
  readonly opacity: PressureCurve;
  /** How much paper tooth breaks up the body of the line (0 = clean ink). */
  readonly grain: number;
}

const MATERIALS: Record<string, HardMaterial> = {
  // even and clean: width follows pressure closely, from a hairline at a
  // whisper to full width; a light touch is a little lighter, never faint
  pen: {
    width: { from: 0, to: 1, gamma: 1.2 },
    opacity: { from: 0.6, to: 1, gamma: 1 },
    grain: 0,
  },
  // sharp graphite: pressure changes width AND how much lead is laid down
  pencil: {
    width: { from: 0.12, to: 1, gamma: 1.2 },
    opacity: { from: 0.3, to: 1, gamma: 1.1 },
    grain: 0.55,
  },
  // brush pen: a hairline at a whisper, little until pressed, then a heavy swell;
  // light strokes come out soft grey, pressed ones solid
  ink: {
    width: { from: 0, to: 1, gamma: 1.9, ease: 0.2 },
    opacity: { from: 0.35, to: 1, gamma: 1 },
    grain: 0,
  },
};

/** The line a pen draws at zero pressure, in CANVAS px. Every pressure above
 *  zero opens it continuously from here: it is the start of the curve, not a
 *  clamp on it, so there is no flat zone at the light end. */
const HAIRLINE = 0.3;

/** ...and never thinner than this in LAYER px. On a zoomed-in layer the screen
 *  hairline is a few hundredths of a layer pixel, and 8-bit pixels cannot hold
 *  that much ink without breaking it into isolated grey dots. */
const HAIRLINE_LAYER = 0.25;

export interface HardTip {
  /** Half the line width, layer px. */
  readonly radius: number;
  /** Ink opacity 0..1, before the intensity slider. */
  readonly opacity: number;
}

/**
 * Pressure → the physical tip: input pressure → material curve → diameter.
 *
 *     d(p) = hairline + (full − hairline) · W(p)
 *
 * W is the material's continuous, monotone curve (curves.ts), so d is
 * continuous and strictly increasing wherever W is, with no thresholds: two
 * pressures a hair apart give two widths a hair apart, from 0 to 1. The hairline
 * never exceeds half the brush, so a tiny brush still thins under a light hand.
 */
export function hardTip(material: string, pressure: number, size: number, scale: number): HardTip {
  const m = MATERIALS[material] ?? MATERIALS.pen;
  const full = 2 * Math.max(0, size);
  const hair = Math.min(Math.max(HAIRLINE / Math.max(1e-6, scale), HAIRLINE_LAYER), full * 0.5);
  const d = hair + (full - hair) * pressureCurve(pressure, m.width);
  return { radius: d * 0.5, opacity: clamp01(pressureCurve(pressure, m.opacity)) };
}

/** Vertex spacing along the ribbon, px. The union of spans is exact whatever
 *  their length, so this only sets how closely the polyline follows the cubic:
 *  its chord error is about a hundredth of a pixel on a curve of 10 px radius
 *  and under a tenth on a 2.5 px loop. */
const MIN_SPACING = 1;
const MAX_SPACING = 2;

/** Half-diagonals of a pixel and of a cell: a pixel (cell) whose centre lies
 *  farther than this inside or outside the shape is entirely in (out). */
const PIXEL_REACH = Math.SQRT1_2;
const CELL_REACH = Math.SQRT1_2 * CELL;

/** A final span shorter than this has no direction of its own to cap; it is
 *  folded into the span before it. */
const MIN_END_SPAN = 0.25;

/** Samples per cell edge for the few cells integrated directly (stroke ends,
 *  discs smaller than a cell). */
const FINE = 4;
const FINE_STEP = CELL / FINE;

interface Vertex {
  readonly x: number;
  readonly y: number;
  /** half-width, px */
  readonly r: number;
  /** ink opacity 0..1, intensity included */
  readonly o: number;
}

interface Box { x0: number; y0: number; x1: number; y1: number }

export class HardModel implements BrushModel {
  readonly dirty = new DirtyTracker();
  /** Final per-pixel ink opacity (already includes pressure and intensity). */
  private readonly cov: SubpixelCoverage;
  private readonly ctx: ModelContext;
  private readonly grain: number;
  /** Every vertex of the stroke, in order. */
  private readonly verts: Vertex[] = [];

  constructor(ctx: ModelContext) {
    this.ctx = ctx;
    this.cov = new SubpixelCoverage(ctx.width, ctx.height);
    this.grain = (MATERIALS[ctx.material] ?? MATERIALS.pen).grain;
  }

  private vertexFor(inp: BrushInput): Vertex {
    const t = hardTip(this.ctx.material, inp.pressure, inp.size, this.ctx.scale);
    return { x: inp.x, y: inp.y, r: t.radius, o: t.opacity * this.ctx.intensity };
  }

  spacing(inp: BrushInput): number {
    const r = this.vertexFor(inp).r;
    return Math.min(MAX_SPACING, Math.max(MIN_SPACING, 0.8 + 0.08 * r));
  }

  dab(inp: BrushInput): void {
    const v = this.vertexFor(inp);
    const prev = this.verts[this.verts.length - 1];
    this.verts.push(v);
    // the first vertex shows at once as a dot (and is all a tap ever draws)
    if (!prev) this.disc(v, null);
    else this.cone(prev, v, this.verts.length === 2, false, null);
  }

  /** The pen has lifted: give the stroke its true end cap. */
  settle(): void {
    const v = this.verts;
    if (v.length < 2) return;

    // Every pixel the last spans could have drawn as "the stroke goes on".
    const tail = v.slice(-3);
    let pad = 0;
    for (const p of tail) pad = Math.max(pad, p.r);
    const box = this.bounds(
      Math.min(...tail.map((p) => p.x)) - pad - 1,
      Math.min(...tail.map((p) => p.y)) - pad - 1,
      Math.max(...tail.map((p) => p.x)) + pad + 1,
      Math.max(...tail.map((p) => p.y)) + pad + 1,
      null
    );
    if (!box) return;

    if (v.length >= 3) {
      const p = v[v.length - 2], q = v[v.length - 1];
      if (Math.hypot(q.x - p.x, q.y - p.y) < MIN_END_SPAN) v.splice(v.length - 2, 1);
    }

    // Redraw that box from scratch with every span that reaches it, the last
    // one now known to be the end.
    this.cov.clear(box.x0, box.y0, box.x1, box.y1);
    const n = v.length;
    if (n === 1) this.disc(v[0], box);
    for (let i = 1; i < n; i++) {
      const a = v[i - 1], b = v[i];
      const r = Math.max(a.r, b.r) + 1;
      if (
        Math.max(a.x, b.x) + r < box.x0 || Math.min(a.x, b.x) - r > box.x1 ||
        Math.max(a.y, b.y) + r < box.y0 || Math.min(a.y, b.y) - r > box.y1
      ) continue;
      this.cone(a, b, i === 1, i === n - 1, box);
    }
    this.dirty.add(box.x0, box.y0, box.x1, box.y1);
  }

  /* ---------- geometry ---------- */

  /** Integer pixel box around a shape's bounds, plus the anti-alias margin. */
  private bounds(x0: number, y0: number, x1: number, y1: number, clip: Box | null): Box | null {
    let bx0 = Math.max(0, Math.floor(x0 - 1)), by0 = Math.max(0, Math.floor(y0 - 1));
    let bx1 = Math.min(this.ctx.width, Math.ceil(x1 + 1));
    let by1 = Math.min(this.ctx.height, Math.ceil(y1 + 1));
    if (clip) {
      bx0 = Math.max(bx0, clip.x0); by0 = Math.max(by0, clip.y0);
      bx1 = Math.min(bx1, clip.x1); by1 = Math.min(by1, clip.y1);
    }
    return bx1 > bx0 && by1 > by0 ? { x0: bx0, y0: by0, x1: bx1, y1: by1 } : null;
  }

  /** A lone disc: the first vertex of a stroke, or a tap. */
  private disc(v: Vertex, clip: Box | null): void {
    const box = this.bounds(v.x - v.r, v.y - v.r, v.x + v.r, v.y + v.r, clip);
    if (!box) return;
    const cov = this.cov;
    for (let py = box.y0; py < box.y1; py++) {
      for (let px = box.x0; px < box.x1; px++) {
        const sd = Math.hypot(px + 0.5 - v.x, py + 0.5 - v.y) - v.r;
        if (sd >= PIXEL_REACH) continue;
        if (sd <= -PIXEL_REACH) {
          cov.solid(px, py, v.o);
          continue;
        }
        if (cov.floor(px, py) >= v.o) continue;
        const off = cov.cells(px, py);
        const buf = cov.buf;
        for (let j = 0; j < SUB; j++) {
          const cy = py + (j + 0.5) * CELL;
          for (let i = 0; i < SUB; i++) {
            const c = discCell(px + (i + 0.5) * CELL, cy, v) * v.o;
            const k = off + j * SUB + i;
            if (c > buf[k]) buf[k] = c;
          }
        }
        cov.resolve(px, py, off);
      }
    }
    this.dirty.add(box.x0, box.y0, box.x1, box.y1);
  }

  /**
   * The round cone between two consecutive vertices.
   * `startCap`: `a` is where the stroke began. `endCap`: `b` is where it ended.
   * Otherwise the span is drawn as continuing past its ends, which is exact
   * for the joint it shares with its neighbour.
   */
  private cone(a: Vertex, b: Vertex, startCap: boolean, endCap: boolean, clip: Box | null): void {
    const abx = b.x - a.x, aby = b.y - a.y;
    const l2 = abx * abx + aby * aby;
    if (l2 < 1e-12) {
      this.disc(b.r >= a.r ? b : a, clip);
      return;
    }
    const invL2 = 1 / l2;
    const len = Math.sqrt(l2);
    const ux = abx / len, uy = aby / len;
    // |components| of the edge normal (−uy, ux), for the exact box filter
    const na = Math.abs(uy), nb = Math.abs(ux);
    // the outline of a cone is tilted from the axis by its taper; measuring
    // across the tilted edge keeps the coverage exact where the width is
    // changing fast (the start of an ink stroke)
    const k = (b.r - a.r) / len;
    const cs = 1 / Math.sqrt(1 + k * k);
    // how far a cell (a pixel) reaches along the axis, in units of t; and
    // across it, in cell units
    const half = 0.5 * (na + nb);
    const reach = (half * CELL) / len;
    const pixelReach = (0.5 * (na + nb)) / len;
    const oMax = Math.max(a.o, b.o);
    // the cone lies between the capsules of its smaller and larger radius
    const rLo = Math.min(a.r, b.r), rHi = Math.max(a.r, b.r);
    const outer = rHi + PIXEL_REACH + CELL_REACH;
    const outer2 = outer * outer;
    const inner = rLo - PIXEL_REACH;
    const inner2 = inner > 0 ? inner * inner : -1;

    const box = this.bounds(
      Math.min(a.x - a.r, b.x - b.r), Math.min(a.y - a.r, b.y - b.r),
      Math.max(a.x + a.r, b.x + b.r), Math.max(a.y + a.r, b.y + b.r),
      clip
    );
    if (!box) return;
    const cov = this.cov;
    const value = cov.value, split = cov.split, W = cov.width;
    const behind = -(pixelReach + reach);

    for (let py = box.y0; py < box.y1; py++) {
      const qy = py + 0.5;
      const ey = qy - a.y;
      for (let px = box.x0; px < box.x1; px++) {
        const qx = px + 0.5;
        const ex = qx - a.x;
        const t = (ex * abx + ey * aby) * invL2;
        // wholly behind a joint: the previous span drew all of this pixel
        if (!startCap && t < behind) continue;
        const tc = t < 0 ? 0 : t > 1 ? 1 : t;
        const fx = ex - tc * abx, fy = ey - tc * aby;
        const d2 = fx * fx + fy * fy;
        if (d2 >= outer2) continue;
        const pi = py * W + px;
        const whole = split[pi] === 0;
        // already as dark as this span can make it (the body of a steady line)
        if (whole && value[pi] >= oMax) continue;
        if (d2 <= inner2) {
          const o = a.o + tc * (b.o - a.o);
          if (!whole) cov.solid(px, py, o);
          else if (o > value[pi]) value[pi] = o;
          continue;
        }
        const sd = sdRoundCone(qx, qy, a.x, a.y, a.r, b.x, b.y, b.r);
        if (sd >= PIXEL_REACH + CELL_REACH) continue;
        if (sd <= -PIXEL_REACH) {
          cov.solid(px, py, a.o + tc * (b.o - a.o));
          continue;
        }
        if (cov.floor(px, py) >= oMax) continue;

        const off = cov.cells(px, py);
        const buf = cov.buf;
        for (let j = 0; j < SUB; j++) {
          const cy = py + (j + 0.5) * CELL;
          const ry = cy - a.y;
          for (let i = 0; i < SUB; i++) {
            const cx = px + (i + 0.5) * CELL;
            const rx = cx - a.x;
            const tr = (rx * abx + ry * aby) * invL2;
            let c: number, o: number;
            if (tr < -reach) {
              // behind `a`: a joint's disc is the previous span's to draw
              if (!startCap) continue;
              c = discCell(cx, cy, a);
              o = a.o;
            } else if (tr > 1 + reach) {
              c = discCell(cx, cy, b);
              o = b.o;
            } else {
              const tc = tr < 0 ? 0 : tr > 1 ? 1 : tr;
              o = a.o + tc * (b.o - a.o);
              if ((startCap && tr < reach) || (endCap && tr > 1 - reach)) {
                c = coneCellExact(cx, cy, a, b);
              } else {
                // exact box-filtered strip across the cell, in cell units;
                // an edge farther than `half` from the centre misses the cell
                const r = ((a.r + tc * (b.r - a.r)) * cs) / CELL;
                const d = (Math.abs(ry * ux - rx * uy) * cs) / CELL;
                const near = r - d, far = r + d;
                if (near <= -half) continue;
                if (near >= half && far >= half) c = 1;
                else {
                  c = (near >= half ? 1 : boxCdf(near, na, nb)) + (far >= half ? 1 : boxCdf(far, na, nb)) - 1;
                  c = c < 0 ? 0 : c > 1 ? 1 : c;
                }
              }
            }
            const val = c * o;
            const idx = off + j * SUB + i;
            if (val > buf[idx]) buf[idx] = val;
          }
        }
        cov.resolve(px, py, off);
      }
    }
    this.dirty.add(box.x0, box.y0, box.x1, box.y1);
  }

  /* ---------- composite ---------- */

  composite(target: RasterSurface, region: Rect): void {
    const { width: W, color } = this.ctx;
    const ink = this.cov.value;
    const out = target.data;
    const cr = color.r, cg = color.g, cb = color.b, ca = color.a;
    const grain = this.grain;
    const paper = grain > 0 ? paperField("graphite", W, this.ctx.height) : null;
    if (paper) paper.fill(region.x, region.y, region.x + region.w, region.y + region.h);

    for (let y = region.y; y < region.y + region.h; y++) {
      let d = y * W + region.x;
      let i = d * 4;
      for (let x = 0; x < region.w; x++, d++, i += 4) {
        let a = ink[d];
        if (a <= 1 / 2040) continue;
        if (paper) a = grainedInk(a, paper.data[d], grain);
        a *= ca;
        const inv = 1 - a;
        out[i]     = cr * a + out[i]     * inv;
        out[i + 1] = cg * a + out[i + 1] * inv;
        out[i + 2] = cb * a + out[i + 2] * inv;
        out[i + 3] = a + out[i + 3] * inv;
      }
    }
  }
}

/* ---------- cell coverage ---------- */

const ramp = (inside: number): number => {
  const t = 0.5 + inside / FINE_STEP;
  return t < 0 ? 0 : t > 1 ? 1 : t;
};

/** Area of a cell (centre cx, cy) covered by the disc of a vertex. */
function discCell(cx: number, cy: number, v: Vertex): number {
  const dx = cx - v.x, dy = cy - v.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const e = v.r - d;
  if (e >= CELL_REACH) return 1;
  if (e <= -CELL_REACH) return 0;
  if (v.r >= 2 * CELL && d > 1e-9) {
    // at this scale the rim is a straight edge: exact box-filtered half-plane
    return boxCdf(e / CELL, Math.abs(dx / d), Math.abs(dy / d));
  }
  // a disc about the size of the cell: integrate it directly
  let s = 0;
  for (let j = 0; j < FINE; j++) {
    const y = cy + ((j + 0.5) / FINE - 0.5) * CELL - v.y;
    for (let i = 0; i < FINE; i++) {
      const x = cx + ((i + 0.5) / FINE - 0.5) * CELL - v.x;
      s += ramp(v.r - Math.sqrt(x * x + y * y));
    }
  }
  return s / (FINE * FINE);
}

/** Area of a cell covered by the whole cone, integrated directly. Used only at
 *  the stroke's true ends, where the shape stops inside the cell. */
function coneCellExact(cx: number, cy: number, a: Vertex, b: Vertex): number {
  let s = 0;
  for (let j = 0; j < FINE; j++) {
    const y = cy + ((j + 0.5) / FINE - 0.5) * CELL;
    for (let i = 0; i < FINE; i++) {
      const x = cx + ((i + 0.5) / FINE - 0.5) * CELL;
      s += ramp(-sdRoundCone(x, y, a.x, a.y, a.r, b.x, b.y, b.r));
    }
  }
  return s / (FINE * FINE);
}

/**
 * Graphite catches on paper tooth. How much of the line's body survives at a
 * pixel depends on how hard the lead is pressed (the ink opacity stands in for
 * that) against how high the tooth stands there: a light line keeps only the
 * peaks, a firm one fills the valleys. Fully pressed (a = 1) every pixel
 * survives, so the hard edge of a heavy line stays clean.
 */
function grainedInk(a: number, tooth: number, grain: number): number {
  const lo = 1 - 1.3 * a - 0.1;
  const contact = smoothstep(lo, lo + 0.4, tooth);
  const keep = 1 - grain + grain * contact * 1.25;
  return a * (keep > 1 ? 1 : keep);
}
