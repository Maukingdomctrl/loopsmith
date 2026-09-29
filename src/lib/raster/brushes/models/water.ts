/**
 * Water — pigment carried by water.
 *
 * This is not a soft brush with a texture on top. It is a small simulation, run
 * on the paper's own height field, in which the brush deposits WATER and
 * PIGMENT and the physics decides what the stroke looks like:
 *
 *   W  water lying on the paper (a thin film)
 *   M  pigment suspended in that water
 *   S  pigment that has settled onto the paper (permanent)
 *
 * Each dab deposits water and pigment under a soft footprint; then the film
 * evolves one step:
 *
 *   SPREAD    Water wicks outward, faster where it is deep (a porous-medium law),
 *             so the wet region has a sharp front, not a blurry one. Pigment
 *             rides the flow at the concentration of the cell it leaves.
 *   DRIFT     A little pigment also creeps toward the thinner water — the
 *             capillary flow that drags colour to the edge of a wash.
 *   EVAPORATE Thin water dries first, so the rim of a wash dries before its
 *             body. Whatever pigment reached the rim is left there: a hard,
 *             dark edge that FORMED from the transport, at the place the front
 *             stopped. Nothing is drawn as an outline.
 *   SETTLE    Suspended pigment falls out onto the paper — faster in the valleys
 *             of the tooth (granulation) and faster as the film thins. When a
 *             cell runs dry, all the pigment still in it is fixed there.
 *
 * The rest follows from the brush loading:
 *
 *   - The brush starts loaded: a stronger, defined first mark, then pigment is
 *     progressively DILUTED while the water keeps coming, so the stroke goes
 *     dark → soft → softer and its rim weakens as it goes.
 *   - PRESSURE is water and pigment: harder = a wider, wetter, richer stroke;
 *     lighter = a pale wash that never builds a rim.
 *   - SPEED starves the stroke: fast passes carry less water and skip the tooth.
 *   - Wet paint over its own damp track pushes water outward: blooms and
 *     pooling appear where the hand slows, doubles back or dwells, because
 *     that is where water accumulates.
 *
 * COMPOSITING is a glaze (Beer–Lambert), not alpha-over: pigment over existing
 * pigment multiplies, so overlapping washes deepen and saturate the way real
 * ones do, instead of just stacking opacity.
 *
 * One simulation step runs per dab, and dabs are placed by arc length, so the
 * result depends on the path and the hand — never on the frame rate.
 */

import type { Rect } from "@/types/geometry";
import { DirtyTracker, RasterSurface } from "../../surface";
import type { BrushInput, BrushModel, ModelContext } from "../types";
import { mix, pressureCurve, smoothstep, type PressureCurve } from "../curves";
import {
  chordIntegral,
  footprintBounds,
  kernel,
  pixelSafeRadius,
  roundFootprint,
} from "../footprint";
import { valueNoise1 } from "../noise";
import { paperField, type PaperField } from "../paper";

/* ---------- tuning ---------- */

/** Pressure → water laid down (a whisper of pressure still wets the paper). */
const WATER: PressureCurve = { from: 0.14, to: 1, gamma: 1.05 };
/** Pressure → pigment laid down (much more selective: light = pale wash). */
const PIGMENT: PressureCurve = { from: 0.05, to: 1, gamma: 1.5 };
/** Pressure → footprint radius (fraction of size): pressing widens the mark. */
const SPREAD_RADIUS: PressureCurve = { from: 0.62, to: 1, gamma: 0.9 };

/**
 * The physics constants. One object so the whole behaviour of the brush is
 * auditable — and adjustable in tests — from a single place.
 */
export const WATER_TUNING = {
  /** Film depth at the centre of one full-pressure pass. */
  waterMax: 1,
  /** Pigment density at the centre of one full pass (all settled in place). */
  pigmentMax: 3,

  /** Brush loading along the stroke, in brush radii of travel. */
  loadStart: 1.5,       // first mark: a loaded brush
  loadEnd: 0.55,        // then diluted, as water outlasts pigment
  loadRun: 9,
  waterStart: 1.3,      // the touch-down pool
  waterStartRun: 1.5,
  waterRun: 26,
  waterEnd: 0.72,

  /** Outward wicking of water (∝ depth^wickPower) and its stability cap. */
  kappa: 0.16,
  wickPower: 2,
  flowCap: 0.24,
  /** Pigment drift toward thinner water, per step, on the RELATIVE depth
   *  difference across a face — so it stays strong right at the wet front,
   *  where the absolute difference is small but the relative one is total. */
  eta: 0.4, // stronger pulls most pigment to the rim: a pale body in a hard outline (scaled by size in `edgeDrift`)
  driftSoft: 0.02,
  /** Drift into tooth valleys is stronger than onto peaks (0 = indifferent). */
  driftValley: 0.3,
  /** How strongly the paper's tooth shapes settling, drying and drift
   *  (granulation). 0 = a perfectly smooth sheet. */
  granulation: 0.3,

  /** Evaporation per step: a constant part (thin films vanish first) and a part
   *  proportional to depth. Tooth peaks dry a little faster than valleys. */
  evapConst: 0.025,
  evapProp: 0.012,
  /** Depth below which a film evaporates in proportion to its depth instead of
   *  at a constant rate. Without it a thin film vanishes in a single step, and
   *  that hard event, repeated once per dab, prints the dab spacing into the
   *  stroke as a fine regular ripple. */
  evapKnee: 0.06,
  /** Simulation steps per dab (each 1/n as large). */
  stepsPerDab: 1,
  /** Settling per step: a base rate and an extra as the film thins. */
  settleBase: 0.006,
  settleThin: 0.02,
  thinHalf: 0.14,
  /** Below this depth a cell is dry: all its pigment is fixed. */
  dry: 0.004,
  /** How much suspended (still wet) pigment shows, relative to settled. */
  wetVisible: 0.85,

  /** Dab spacing as a fraction of the footprint radius. Fine, because the film
   *  advances one step per dab: the coarser the spacing, the more of the stroke's
   *  timing is baked into the result as a ripple of that period. */
  spacing: 0.09,
  /** Spacing (in radii) the per-step rates below were tuned at. Rates are scaled
   *  by spacing / spacingRef, so behaviour per unit of TRAVEL does not depend on
   *  how finely the path happens to be sampled. */
  spacingRef: 0.17,
  /** Finishing: the last wet stretch is dried quickly once the pen lifts. */
  settleSteps: 90,
  settleEvap: 2.4,
  /** Opaque fraction mixed into the glaze, so a wash stays visible over dark
   *  paint instead of vanishing (real watercolour cannot lighten, a canvas must). */
  opaqueMix: 0.15,
};

const MIN_SPACING = 0.5;

export class WaterModel implements BrushModel {
  readonly dirty = new DirtyTracker();
  private readonly ctx: ModelContext;
  private readonly w: number;
  private readonly h: number;
  private readonly water: Float32Array;
  private readonly pig: Float32Array;
  private readonly stain: Float32Array;
  private readonly paper: PaperField;
  /**
   * Scratch for one step, sized to the WET WINDOW rather than the surface (a
   * 4096² import would otherwise cost half a gigabyte for a stroke that wets a
   * few thousand pixels). Grown geometrically, so it reallocates rarely.
   *   hFlux/hPig  water and pigment moved from cell x−1 into x
   *   vFlux/vPig  … from the cell above into this one
   *   smooth      water smoothed over a cell's neighbours: what drift follows
   */
  private scratchCap = 0;
  private hFlux = new Float32Array(0);
  private hPig = new Float32Array(0);
  private vFlux = new Float32Array(0);
  private vPig = new Float32Array(0);
  private smooth = new Float32Array(0);
  private readonly lut: Float32Array;

  /** Cells that may still be wet, half-open. Empty when x1 <= x0. */
  private bx0 = 0; private by0 = 0; private bx1 = 0; private by1 = 0;
  private active = false;
  /** Edge drift for this brush size (see `edgeDrift`). */
  private readonly eta: number;

  constructor(ctx: ModelContext) {
    this.ctx = ctx;
    this.eta = edgeDrift(ctx.size * ctx.scale);
    this.w = ctx.width;
    this.h = ctx.height;
    const n = ctx.width * ctx.height;
    this.water = new Float32Array(n);
    this.pig = new Float32Array(n);
    this.stain = new Float32Array(n);
    this.paper = paperField("coldpress", ctx.width, ctx.height);
    this.lut = buildGlazeLut(ctx.color);
  }

  /* ---------- deposit ---------- */

  private radiusFor(inp: BrushInput): number {
    return inp.size * pressureCurve(inp.pressure, SPREAD_RADIUS);
  }

  /** Dab spacing in px. Fine for small brushes; a big brush relaxes it a little
   *  (the ripple a coarse spacing prints is a fixed number of px, so it stays
   *  invisible) which keeps the simulation affordable at radius 64. */
  private spacingFor(r: number): number {
    const relax = 1 + 0.5 * Math.min(1, Math.max(0, (r - 24) / 40));
    return Math.max(MIN_SPACING, WATER_TUNING.spacing * relax * r);
  }

  spacing(inp: BrushInput): number {
    return this.spacingFor(this.radiusFor(inp));
  }

  dab(inp: BrushInput): void {
    const r0 = this.radiusFor(inp);
    const { radius: r, gain } = pixelSafeRadius(r0);
    const fp = roundFootprint(inp.x, inp.y, r, r, 0, 0.12);

    const spacing = this.spacingFor(r0);
    const chord = chordIntegral(fp, inp.tangent.x, inp.tangent.y);
    // a tap lays down what one pass through its centre would: a wet touch that
    // pools, dries at its rim and shows what the brush is made of
    let ds = inp.ds;
    if (inp.first) ds = inp.remaining === 0 ? chord : spacing * 0.5;
    if (ds <= 0) return;

    // brush loading along the stroke, in radii of travel
    const travelled = inp.distance / Math.max(1e-6, inp.size);
    const load = mix(WATER_TUNING.loadEnd, WATER_TUNING.loadStart, Math.exp(-travelled / WATER_TUNING.loadRun));
    const pool = 1 + (WATER_TUNING.waterStart - 1) * Math.exp(-travelled / WATER_TUNING.waterStartRun);
    const drying = mix(WATER_TUNING.waterEnd, 1, Math.exp(-travelled / WATER_TUNING.waterRun));
    // the brush does not release evenly: a slow, smooth swell of loading
    const pulse = 1 + 0.9 * (valueNoise1(inp.distance / (5 * inp.size + 6), this.ctx.seed) - 0.5);
    const fast = smoothstep(0, 6, inp.velocity); // canvas px per ms: only a flick counts as fast
    const speedWater = mix(1.12, 0.55, fast);

    const scale = (ds * gain) / chord;
    const wAmt = WATER_TUNING.waterMax * pressureCurve(inp.pressure, WATER) * speedWater * pool * drying * pulse * scale;
    const pAmt = WATER_TUNING.pigmentMax * this.ctx.intensity * pressureCurve(inp.pressure, PIGMENT) * load * pulse * scale;

    const b = footprintBounds(fp, this.w, this.h, 1);
    if (b) {
      const W = this.w;
      for (let y = b.y0; y < b.y1; y++) {
        let i = y * W + b.x0;
        for (let x = b.x0; x < b.x1; x++, i++) {
          const k = kernel(fp, x + 0.5, y + 0.5);
          if (k <= 0) continue;
          this.water[i] += wAmt * k;
          this.pig[i] += pAmt * k;
        }
      }
      this.grow(b.x0, b.y0, b.x1, b.y1);
    }
    const rate = Math.min(1, spacing / (WATER_TUNING.spacingRef * Math.max(1e-6, r0)));
    const n = Math.max(1, Math.round(WATER_TUNING.stepsPerDab));
    for (let k = 0; k < n; k++) this.step(1, rate / n);
  }

  /* ---------- the film ---------- */

  private ensureScratch(n: number): void {
    if (n <= this.scratchCap) return;
    const cap = Math.ceil(n * 1.5);
    this.hFlux = new Float32Array(cap);
    this.hPig = new Float32Array(cap);
    this.vFlux = new Float32Array(cap);
    this.vPig = new Float32Array(cap);
    this.smooth = new Float32Array(cap);
    this.scratchCap = cap;
  }

  private grow(x0: number, y0: number, x1: number, y1: number): void {
    if (!this.active) {
      this.bx0 = x0; this.by0 = y0; this.bx1 = x1; this.by1 = y1;
      this.active = true;
    } else {
      if (x0 < this.bx0) this.bx0 = x0;
      if (y0 < this.by0) this.by0 = y0;
      if (x1 > this.bx1) this.bx1 = x1;
      if (y1 > this.by1) this.by1 = y1;
    }
  }

  /**
   * One step of the film over the wet region. `evap` scales drying.
   *
   * A Jacobi update: every face flux is computed from ONE snapshot of the
   * fields and only then applied. Updating cell by cell in place would make the
   * result depend on the sweep direction — the wash would creep toward whichever
   * corner the loop starts from. The window carries a dry margin, so a front
   * that moves out of the wet region has somewhere to go; the surface border
   * itself is a wall.
   */
  private step(evap: number, rate = 1): void {
    if (!this.active) return;
    const T = WATER_TUNING;
    const W = this.w, Hh = this.h;
    const x0 = Math.max(0, this.bx0 - 1), x1 = Math.min(W, this.bx1 + 1);
    const y0 = Math.max(0, this.by0 - 1), y1 = Math.min(Hh, this.by1 + 1);
    if (x1 <= x0 || y1 <= y0) { this.active = false; return; }
    this.paper.fill(x0, y0, x1, y1);

    const ww = x1 - x0;
    this.ensureScratch(ww * (y1 - y0));
    const wat = this.water, pig = this.pig;
    const tooth = this.paper.data, stain = this.stain;
    const hf = this.hFlux, hp = this.hPig, vf = this.vFlux, vp = this.vPig;

    // Drift follows the wash's overall depth gradient, not the cell-to-cell
    // differences that evaporation over the tooth leaves behind — those would
    // be amplified into a per-pixel speckle.
    const sm = this.smooth;
    for (let y = y0; y < y1; y++) {
      let i = y * W + x0;
      let l = (y - y0) * ww;
      for (let x = x0; x < x1; x++, i++, l++) {
        const left = x > x0 ? wat[i - 1] : wat[i];
        const right = x < x1 - 1 ? wat[i + 1] : wat[i];
        const up = y > y0 ? wat[i - W] : wat[i];
        const down = y < y1 - 1 ? wat[i + W] : wat[i];
        sm[l] = (4 * wat[i] + left + right + up + down) * 0.125;
      }
    }

    // ---- 1. face fluxes from the snapshot ----------------------------------
    // hf[l] moves water from the cell to the left into cell l (vf[l]: from above).
    // Surface index i addresses the fields; window index l addresses the scratch.
    for (let y = y0; y < y1; y++) {
      let i = y * W + x0 + 1;
      let l = (y - y0) * ww + 1;
      for (let x = x0 + 1; x < x1; x++, i++, l++) {
        this.face(wat, pig, sm, tooth, i - 1, i, l - 1, l, hf, hp, rate);
      }
    }
    for (let y = y0 + 1; y < y1; y++) {
      let i = y * W + x0;
      let l = (y - y0) * ww;
      for (let x = x0; x < x1; x++, i++, l++) {
        this.face(wat, pig, sm, tooth, i - W, i, l - ww, l, vf, vp, rate);
      }
    }

    // ---- 2. apply, then evaporate / settle / fix ---------------------------
    let nx0 = W, ny0 = Hh, nx1 = 0, ny1 = 0;
    const dry = T.dry;
    for (let y = y0; y < y1; y++) {
      let i = y * W + x0;
      let l = (y - y0) * ww;
      for (let x = x0; x < x1; x++, i++, l++) {
        let dw = 0, dp = 0;
        if (x > x0)     { dw += hf[l];      dp += hp[l]; }
        if (x < x1 - 1) { dw -= hf[l + 1];  dp -= hp[l + 1]; }
        if (y > y0)     { dw += vf[l];      dp += vp[l]; }
        if (y < y1 - 1) { dw -= vf[l + ww]; dp -= vp[l + ww]; }

        let wv = wat[i] + dw;
        let m = pig[i] + dp;
        if (wv < 0) wv = 0;
        if (m < 0) m = 0;
        if (wv <= 0 && m <= 0) { wat[i] = 0; pig[i] = 0; continue; }

        const t = 0.5 + (tooth[i] - 0.5) * T.granulation;
        const knee = T.evapKnee > 0 ? wv / (wv + T.evapKnee) : 1;
        wv -= rate * evap * (T.evapConst * (0.85 + 0.3 * t) * knee + T.evapProp * wv);
        if (wv <= dry) {
          // dry: everything still suspended is fixed where it lies
          stain[i] += m;
          wat[i] = 0; pig[i] = 0;
          continue;
        }
        const thin = 1 - wv / (wv + T.thinHalf);
        let q = rate * m * (T.settleBase + T.settleThin * thin) * (0.75 + 0.55 * (1 - t));
        if (q > m) q = m;
        stain[i] += q;
        wat[i] = wv; pig[i] = m - q;
        if (x < nx0) nx0 = x;
        if (x >= nx1) nx1 = x + 1;
        if (y < ny0) ny0 = y;
        if (y >= ny1) ny1 = y + 1;
      }
    }
    this.dirty.add(x0, y0, x1, y1);
    if (nx1 > nx0 && ny1 > ny0) {
      this.bx0 = nx0; this.by0 = ny0; this.bx1 = nx1; this.by1 = ny1;
    } else {
      this.active = false;
    }
  }

  /**
   * Flux across the face between cells `a` and `b` (a positive flux moves water
   * a → b).
   *
   * Water wicks down the depth gradient at a rate that grows with depth (a sharp
   * front), capped so a face never moves more than a quarter of its donor.
   * Pigment rides that flow at the donor's concentration. On top of that it
   * DRIFTS toward the thinner side, at a rate set by the RELATIVE difference in
   * depth: at the edge of a wash, where a film meets bare paper, that difference
   * is total however thin the film, so pigment keeps arriving at the front —
   * and is left there as the film retreats. Drift into a tooth valley is
   * stronger than onto a peak, which is what makes an edge beaded and selective
   * instead of a uniform outline.
   */
  private face(
    wat: Float32Array, pig: Float32Array, sm: Float32Array, tooth: Float32Array,
    a: number, b: number, la: number, lb: number,
    fOut: Float32Array, pOut: Float32Array, rate: number
  ): void {
    const T = WATER_TUNING;
    const wa = wat[a], wb = wat[b];
    if (wa <= T.dry && wb <= T.dry) {
      fOut[lb] = 0; pOut[lb] = 0;
      return;
    }
    const diff = wa - wb;
    const kf = 0.5 * (wa + wb);
    let f = rate * T.kappa * (T.wickPower === 2 ? kf * kf : kf) * diff;
    let conc: number;
    if (f >= 0) {
      const cap = T.flowCap * wa;
      if (f > cap) f = cap;
      conc = wa > T.dry ? pig[a] / wa : 0;
    } else {
      const cap = -T.flowCap * wb;
      if (f < cap) f = cap;
      conc = wb > T.dry ? pig[b] / wb : 0;
    }
    let pf = f * conc;

    const sdiff = sm[la] - sm[lb];
    if (sdiff !== 0) {
      const rel = Math.abs(sdiff) / (sm[la] + sm[lb] + T.driftSoft);
      if (sdiff > 0) {
        // toward b: a valley at b invites pigment
        const valley = 1 + T.driftValley * (0.5 - tooth[b]) * 2 * T.granulation;
        const d = rate * this.eta * pig[a] * rel * (valley > 0 ? valley : 0), cap = T.flowCap * pig[a];
        pf += d < cap ? d : cap;
      } else {
        const valley = 1 + T.driftValley * (0.5 - tooth[a]) * 2 * T.granulation;
        const d = rate * this.eta * pig[b] * rel * (valley > 0 ? valley : 0), cap = T.flowCap * pig[b];
        pf -= d < cap ? d : cap;
      }
    }
    fOut[lb] = f; pOut[lb] = pf;
  }

  settle(): void {
    for (let n = 0; n < WATER_TUNING.settleSteps && this.active; n++) this.step(WATER_TUNING.settleEvap);
    // anything still wet after the cap is fixed where it lies
    if (this.active) {
      const W = this.w;
      for (let y = this.by0; y < this.by1; y++) {
        for (let x = this.bx0; x < this.bx1; x++) {
          const i = y * W + x;
          this.stain[i] += this.pig[i];
          this.pig[i] = 0; this.water[i] = 0;
        }
      }
      this.dirty.add(this.bx0, this.by0, this.bx1, this.by1);
      this.active = false;
    }
  }

  /* ---------- composite ---------- */

  composite(target: RasterSurface, region: Rect): void {
    const Wd = this.w;
    const out = target.data;
    const { color } = this.ctx;
    const lut = this.lut;
    const mixOpaque = WATER_TUNING.opaqueMix;
    const wetVisible = WATER_TUNING.wetVisible;

    for (let y = region.y; y < region.y + region.h; y++) {
      let d = y * Wd + region.x;
      let i = d * 4;
      for (let x = 0; x < region.w; x++, d++, i += 4) {
        const dens = this.stain[d] + wetVisible * this.pig[d];
        if (dens <= 1 / 2040) continue;

        // every density-dependent term comes from one interpolated table
        const f = (dens < LUT_MAX ? dens : LUT_MAX) * LUT_SCALE;
        const k = f | 0;
        const u = f - k;
        const o = k * LUT_STRIDE;
        const a  = lut[o]     + (lut[o + LUT_STRIDE]     - lut[o])     * u;
        const er = lut[o + 1] + (lut[o + 1 + LUT_STRIDE] - lut[o + 1]) * u;
        const eg = lut[o + 2] + (lut[o + 2 + LUT_STRIDE] - lut[o + 2]) * u;
        const eb = lut[o + 3] + (lut[o + 3 + LUT_STRIDE] - lut[o + 3]) * u;
        const tr = lut[o + 4] + (lut[o + 4 + LUT_STRIDE] - lut[o + 4]) * u;
        const tg = lut[o + 5] + (lut[o + 5 + LUT_STRIDE] - lut[o + 5]) * u;
        const tb = lut[o + 6] + (lut[o + 6 + LUT_STRIDE] - lut[o + 6]) * u;

        const dr = out[i], dg = out[i + 1], db = out[i + 2], da = out[i + 3];
        // over bare paper: the wash's own colour, deepening where pigment pools;
        // over paint already there: a glaze that filters what is beneath it
        const free = (1 - da) * a;
        const glazeR = dr * tr + free * er;
        const glazeG = dg * tg + free * eg;
        const glazeB = db * tb + free * eb;
        const inv = 1 - a;
        const overR = color.r * a + dr * inv;
        const overG = color.g * a + dg * inv;
        const overB = color.b * a + db * inv;

        out[i]     = glazeR + (overR - glazeR) * mixOpaque;
        out[i + 1] = glazeG + (overG - glazeG) * mixOpaque;
        out[i + 2] = glazeB + (overB - glazeB) * mixOpaque;
        out[i + 3] = a + da * inv;
      }
    }
  }
}

/**
 * How strongly pigment drifts to the edge, by brush radius in canvas px.
 *
 * The darkened rim is a couple of pixels wide whatever the brush size, so at
 * full strength a small brush is ALL rim: a hollow outline with a white centre.
 * Small brushes get almost none; from about radius 30 the full `eta` applies.
 */
function edgeDrift(radiusPx: number): number {
  return WATER_TUNING.eta * (0.05 + 0.95 * smoothstep(4, 30, radiusPx));
}

/**
 * The glaze as a table over density.
 *
 * Pigment absorbs per channel: transmittance = colour ^ density, so the colour
 * picked is what a density-1 layer looks like and every extra unit of density
 * deepens it multiplicatively. All the terms are smooth in density, so a
 * 128-per-unit table interpolated linearly is exact to well under an 8-bit
 * step — and replaces six `pow` and one `exp` per pixel.
 */
const LUT_MAX = 8;
const LUT_SCALE = 128;
const LUT_STRIDE = 7;
function buildGlazeLut(color: { r: number; g: number; b: number; a: number }): Float32Array {
  const n = LUT_MAX * LUT_SCALE + 2;
  const lut = new Float32Array(n * LUT_STRIDE);
  const lr = Math.max(0.02, color.r), lg = Math.max(0.02, color.g), lb = Math.max(0.02, color.b);
  const ca = color.a;
  for (let k = 0; k < n; k++) {
    const dens = k / LUT_SCALE;
    const deep = 1 + softplus(dens - 1.2);
    const o = k * LUT_STRIDE;
    lut[o]     = (1 - Math.exp(-dens)) * ca;
    lut[o + 1] = Math.pow(lr, deep);
    lut[o + 2] = Math.pow(lg, deep);
    lut[o + 3] = Math.pow(lb, deep);
    lut[o + 4] = Math.pow(lr, dens * ca);
    lut[o + 5] = Math.pow(lg, dens * ca);
    lut[o + 6] = Math.pow(lb, dens * ca);
  }
  return lut;
}

/** Smooth max(0, x): keeps the deepening of pooled pigment free of a crease. */
function softplus(x: number): number {
  return x > 8 ? x : Math.log(1 + Math.exp(2 * x)) / 2;
}
