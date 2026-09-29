/**
 * Hard Linework — the precision brush.
 *
 * NOT A STAMP. Nothing here places a disc at each point and hopes the discs
 * merge. The stroke is GEOMETRY: a ribbon whose width is a continuous function
 * of pressure, swept along the curve, and rendered analytically:
 *
 *     pressure → continuous half-width r(s) → ribbon → exact-area coverage
 *
 * The curve is the existing arc-length-resampled path. Each pair of consecutive
 * points bounds a "round cone" — the convex hull of two discs of different
 * radii — and every pixel near it gets the EXACT area a strip of the local
 * width covers of that pixel (see analytic.ts). Adjacent cones share their
 * end disc, so the union is seamless: no scallops, no beads, no gaps, and a
 * width that changes as smoothly as the pressure does.
 *
 * "Hard" is the edge: a one-pixel analytic anti-alias at any width, so a
 * hairline and a thick line are equally crisp. Pressure changes how wide the
 * ink is and how dark: a light touch gives a thin, softer grey line.
 */

import type { Rect } from "@/types/geometry";
import { DirtyTracker, RasterSurface } from "../../surface";
import type { BrushInput, BrushModel, ModelContext } from "../types";
import { clamp01, pressureCurve, smoothstep, type PressureCurve } from "../curves";
import { discCoverageSuper, stripCoverage } from "../analytic";
import { paperField } from "../paper";

/* ---------- materials ---------- */

export interface HardMaterial {
  /** Pressure → fraction of the full width. */
  readonly width: PressureCurve;
  /** Pressure → opacity of the ink. Graphite thins out under a light hand. */
  readonly opacity: PressureCurve;
  /** How much paper tooth breaks up the body of the line (0 = clean ink). */
  readonly grain: number;
}

export const MATERIALS: Record<string, HardMaterial> = {
  // even and clean: width follows pressure from a hairline at a whisper to full
  // width; a light touch is a thin line that stays dark and crisp, only a
  // little lighter
  pen: {
    width: { from: 0.02, to: 1, gamma: 1.4 },
    opacity: { from: 0.5, to: 1, gamma: 0.6 },
    grain: 0,
  },
  // sharp graphite: pressure changes width AND how much lead is laid down
  pencil: {
    width: { from: 0.12, to: 1, gamma: 1.2 },
    opacity: { from: 0.35, to: 1, gamma: 0.8 },
    grain: 0.55,
  },
  // brush pen: a hairline at a whisper, little until pressed, then a heavy swell;
  // light strokes are fine dark hairlines, pressed ones solid
  ink: {
    width: { from: 0.015, to: 1, gamma: 1.9, ease: 0.2 },
    opacity: { from: 0.45, to: 1, gamma: 0.6 },
    grain: 0,
  },
};

/** The thinnest line that is still a line, in CANVAS px. A stroke narrower than
 *  this is rendered at this width so a feather-light touch stays a hairline
 *  instead of vanishing. */
const HAIRLINE = 0.3;

/** Vertex spacing along the ribbon, px. The curve is a cubic; this keeps the
 *  chord error of the polyline far below a hundredth of a pixel. */
const MIN_SPACING = 0.35;
const MAX_SPACING = 1;

interface Vertex {
  readonly x: number;
  readonly y: number;
  /** half-width, px */
  readonly r: number;
  /** ink opacity 0..1 */
  readonly o: number;
}

export class HardModel implements BrushModel {
  readonly dirty = new DirtyTracker();
  /** Final per-pixel ink opacity (already includes pressure and intensity). */
  private readonly ink: Float32Array;
  private readonly ctx: ModelContext;
  private readonly mat: HardMaterial;
  private readonly hairline: number;
  private prev: Vertex | null = null;

  constructor(ctx: ModelContext) {
    this.ctx = ctx;
    this.ink = new Float32Array(ctx.width * ctx.height);
    this.mat = MATERIALS[ctx.material] ?? MATERIALS.pen;
    this.hairline = HAIRLINE / Math.max(1e-6, ctx.scale);
  }

  private vertexFor(inp: BrushInput): Vertex {
    const full = 2 * inp.size;
    const diameter = Math.max(this.hairline, full * pressureCurve(inp.pressure, this.mat.width));
    return {
      x: inp.x,
      y: inp.y,
      r: diameter * 0.5,
      o: clamp01(pressureCurve(inp.pressure, this.mat.opacity)) * this.ctx.intensity,
    };
  }

  spacing(inp: BrushInput): number {
    const r = this.vertexFor(inp).r;
    return Math.min(MAX_SPACING, Math.max(MIN_SPACING, 0.25 + 0.06 * r));
  }

  dab(inp: BrushInput): void {
    const v = this.vertexFor(inp);
    if (this.prev) this.cone(this.prev, v);
    else this.dot(v);
    this.prev = v;
  }

  /* ---------- geometry ---------- */

  /** A lone dot: the cap of the stroke's first vertex, or a tap. */
  private dot(v: Vertex): void {
    const { width: W, height: H } = this.ctx;
    const pad = v.r + 1;
    const x0 = Math.max(0, Math.floor(v.x - pad)), x1 = Math.min(W, Math.ceil(v.x + pad));
    const y0 = Math.max(0, Math.floor(v.y - pad)), y1 = Math.min(H, Math.ceil(v.y + pad));
    // Supersample below ~0.9 px (where the strip approximation overestimates),
    // blend into the analytic form as the radius grows.
    const blend = smoothstep(0.5, 0.9, v.r);

    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const qx = px + 0.5, qy = py + 0.5;
        const dx = qx - v.x, dy = qy - v.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > v.r + 0.75) continue;
        let c: number;
        if (blend < 1) {
          const s = discCoverageSuper(px, py, v.x, v.y, v.r);
          if (blend <= 0) c = s;
          else {
            const nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0;
            c = s + (stripCoverage(d, v.r, nx, ny) - s) * blend;
          }
        } else {
          const nx = d > 1e-6 ? dx / d : 1, ny = d > 1e-6 ? dy / d : 0;
          c = stripCoverage(d, v.r, nx, ny);
        }
        this.put(py * W + px, c * v.o);
      }
    }
    this.dirty.add(x0, y0, x1, y1);
  }

  /** The round cone between two consecutive vertices. */
  private cone(a: Vertex, b: Vertex): void {
    const { width: W, height: H } = this.ctx;
    const abx = b.x - a.x, aby = b.y - a.y;
    const l2 = abx * abx + aby * aby;
    if (l2 < 1e-12) return;
    const invL2 = 1 / l2;
    const invL = 1 / Math.sqrt(l2);
    // the outline of a cone is tilted from the axis by its taper; measuring
    // distance across the tilted edge keeps the anti-alias exact where the
    // width is changing fast (the start of an ink stroke)
    const k = (b.r - a.r) * invL;
    const cs = 1 / Math.sqrt(1 + k * k);
    const perpX = -aby * invL, perpY = abx * invL;

    const rr = Math.max(a.r, b.r);
    const pad = rr + 1;
    const x0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - pad));
    const x1 = Math.min(W, Math.ceil(Math.max(a.x, b.x) + pad));
    const y0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - pad));
    const y1 = Math.min(H, Math.ceil(Math.max(a.y, b.y) + pad));

    for (let py = y0; py < y1; py++) {
      const qy = py + 0.5;
      let i = py * W + x0;
      for (let px = x0; px < x1; px++, i++) {
        const qx = px + 0.5;
        let t = ((qx - a.x) * abx + (qy - a.y) * aby) * invL2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = qx - (a.x + t * abx), dy = qy - (a.y + t * aby);
        const d2 = dx * dx + dy * dy;
        const r = a.r + t * (b.r - a.r);
        const reach = r + 0.75;
        if (d2 >= reach * reach) continue;
        const d = Math.sqrt(d2);
        let nx: number, ny: number;
        if (d > 1e-6) { nx = dx / d; ny = dy / d; } else { nx = perpX; ny = perpY; }
        const c = stripCoverage(d * cs, r * cs, nx, ny);
        if (c > 0) this.put(i, c * (a.o + t * (b.o - a.o)));
      }
    }
    this.dirty.add(x0, y0, x1, y1);
  }

  /** Union of ink: the more opaque of what is there and what is laid down. */
  private put(i: number, v: number): void {
    if (v > this.ink[i]) this.ink[i] = v > 1 ? 1 : v;
  }

  settle(): void {
    /* ink is dry the moment it is laid */
  }

  /* ---------- composite ---------- */

  composite(target: RasterSurface, region: Rect): void {
    const { width: W, color } = this.ctx;
    const out = target.data;
    const cr = color.r, cg = color.g, cb = color.b, ca = color.a;
    const grain = this.mat.grain;
    const paper = grain > 0 ? paperField("graphite", W, this.ctx.height) : null;
    if (paper) paper.fill(region.x, region.y, region.x + region.w, region.y + region.h);

    for (let y = region.y; y < region.y + region.h; y++) {
      let d = y * W + region.x;
      let i = d * 4;
      for (let x = 0; x < region.w; x++, d++, i += 4) {
        let a = this.ink[d];
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

/**
 * Graphite catches on paper tooth. How much of the line's body survives at a
 * pixel depends on how hard the lead is pressed (the ink opacity stands in for
 * that) against how high the tooth stands there: a light line keeps only the
 * peaks, a firm one fills the valleys. Fully pressed (a = 1) every pixel
 * survives, so the hard edge of a heavy line stays clean.
 */
export function grainedInk(a: number, tooth: number, grain: number): number {
  const lo = 1 - 1.3 * a - 0.1;
  const contact = smoothstep(lo, lo + 0.4, tooth);
  const keep = 1 - grain + grain * contact * 1.25;
  return a * (keep > 1 ? 1 : keep);
}
