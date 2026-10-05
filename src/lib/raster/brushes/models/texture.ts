/**
 * Texture — grain that belongs to the stroke.
 *
 * The model is CONTACT, not decoration. Nothing is drawn and then textured; the
 * grain is what decides where material transfers at all:
 *
 *   paper    A fixed height field under the canvas (paper.ts): peaks and
 *            valleys, non-tiling, shared by every stroke.
 *   contact  The brush presses down to some depth. A pixel receives material
 *            when the paper's height there reaches that depth.
 *
 * Everything the brief asks of the texture falls out of that one rule:
 *
 *  - PRESSURE sets the depth. A light touch skims only the highest peaks (sparse
 *    grain); a medium one reaches well into the tooth (visible grain); a heavy
 *    one fills nearly every valley (compressed, dense — the grain is still
 *    there, but only as a few pits).
 *  - SPEED shortens contact. A fast stroke skips across the tooth and leaves a
 *    broken deposit; a slow one dwells and lays down more.
 *  - SHAPE is the pressure envelope. Contact pressure is highest at the middle
 *    of the footprint and falls to the rim, so the edge is ragged where the
 *    paper's tooth dictates, with no blur applied to it.
 *  - PREVIOUS DEPOSITS fill the tooth. Material already on a pixel raises the
 *    valley floor there, so a second pass over graphite goes on more evenly
 *    (burnishing) instead of starting again from bare paper.
 *  - DIRECTION. Bristle/fibre streaks are evaluated in STROKE space — offset
 *    across the path and distance along it — so they run with the stroke, bend
 *    with it, and stay continuous along an unbroken line. The paper tooth is
 *    canvas space, so it stays put beneath. The two together are why the result
 *    reads as material dragged over a surface rather than a picture under paint.
 *
 * Dynamics it honours (dynamics.ts): size (the radius it is given), opacity
 * and flow (the deposit), spacing, and texture — the strength of the streaks
 * and of the tooth's say in where material lands (0 = an even deposit).
 */

import type { Rect } from "@/types/geometry";
import { DirtyTracker, RasterSurface } from "../../surface";
import type { BrushInput, BrushModel, ModelContext } from "../types";
import { mix, pressureCurve, smoothstep, type PressureCurve } from "../curves";
import {
  chordIntegral,
  footprintBounds,
  kernel,
  roundFootprint,
  type Footprint,
} from "../footprint";
import { gradNoise2 } from "../noise";
import { paperField, type PaperField, type PaperKind } from "../paper";
import { compositeDensity } from "./density";

interface Surface {
  readonly paper: PaperKind;
  /** Contact depth (fraction of the tooth's height range) at pressure 0 and 1. */
  readonly reachLow: number;
  readonly reachHigh: number;
  /** Width of the contact transition, in tooth height. Small = crisp grain. */
  readonly soft: number;
  /** Streak strength 0..1, and their spatial frequency across / along the stroke. */
  readonly streak: number;
  readonly across: number;
  readonly along: number;
  /** Density where material transfers, before intensity. */
  readonly density: number;
  /** How strongly existing material fills the tooth (0 = not at all). */
  readonly burnish: number;
  /** Loose dust that lands between the tooth as well: the faint continuous tone
   *  under the grain. Without it grain reads as isolated dots on bare paper. */
  readonly dust: number;
  /** How much a fast stroke shortens contact. */
  readonly speedSparse: number;
  /** Plateau of the footprint (0 = pure bell). */
  readonly plateau: number;
  /** Footprint radius as a fraction of the size at light / full pressure. */
  readonly radiusLow: number;
}

const SURFACES: Record<string, Surface> = {
  // sharpened lead on fine paper: crisp tooth, faint hatching, never quite black
  graphite: {
    paper: "graphite", reachLow: 0.16, reachHigh: 0.95, soft: 0.2,
    streak: 0.14, across: 0.6, along: 0.05,
    density: 1.9, burnish: 0.55, dust: 0.22, speedSparse: 0.3, plateau: 0.3, radiusLow: 0.7,
  },
  // powdery and dark, coarse pits, a broken edge that smears with the stroke
  charcoal: {
    paper: "charcoal", reachLow: 0.12, reachHigh: 0.92, soft: 0.26,
    streak: 0.3, across: 0.4, along: 0.03,
    density: 2.9, burnish: 0.35, dust: 0.3, speedSparse: 0.45, plateau: 0.1, radiusLow: 0.8,
  },
  // material sits on the threads of a weave and skips the gaps between them
  canvas: {
    paper: "canvas", reachLow: 0.24, reachHigh: 0.98, soft: 0.14,
    streak: 0.06, across: 0.5, along: 0.04,
    density: 2.3, burnish: 0.25, dust: 0.08, speedSparse: 0.35, plateau: 0.2, radiusLow: 0.8,
  },
  // soft medium tooth with fine fibres — chalk / pastel on paper
  paper: {
    paper: "paper", reachLow: 0.18, reachHigh: 0.96, soft: 0.26,
    streak: 0.1, across: 0.5, along: 0.05,
    density: 2.1, burnish: 0.4, dust: 0.18, speedSparse: 0.3, plateau: 0.2, radiusLow: 0.75,
  },
  // a loaded brush running dry: long bristle streaks, skipping at speed
  dry: {
    paper: "paper", reachLow: 0.3, reachHigh: 1, soft: 0.2,
    streak: 0.95, across: 0.55, along: 0.016,
    density: 2.6, burnish: 0.2, dust: 0.05, speedSparse: 0.7, plateau: 0.25, radiusLow: 0.85,
  },
};

/** Pressure → depth of contact. */
const REACH: PressureCurve = { from: 0, to: 1, gamma: 1.1, ease: 0.1 };
/** Pressure → how much material transfers where there is contact. */
const AMOUNT: PressureCurve = { from: 0.15, to: 1, gamma: 1 };
/** The bristles belong to the brush, not to any one stroke: every stroke drags
 *  the same set, so this seed is a constant rather than per-stroke. */
const BRISTLE_SEED = 7;

/** How much of the local contact pressure comes from the footprint's envelope. */
const ENVELOPE = 0.65;

/** Slow strokes lay down more, fast ones less (canvas px/ms). */
const SPEED_SLOW_GAIN = 1.25;
const SPEED_FAST_GAIN = 0.85;
const SPEED_SPAN = 6; // canvas px per ms: normal drawing (1-3) stays dense, only a flick breaks up

const SPACING_OF_RADIUS = 0.22;
const MIN_SPACING = 0.3;

/** A leaning pen presses a longer, lighter patch. */
const TILT_STRETCH = 1.3;
const TILT_LIGHTEN = 0.35;

export class TextureModel implements BrushModel {
  readonly dirty = new DirtyTracker();
  private readonly density: Float32Array;
  private readonly ctx: ModelContext;
  private readonly surf: Surface;
  private readonly paper: PaperField;

  constructor(ctx: ModelContext) {
    this.ctx = ctx;
    this.surf = SURFACES[ctx.material] ?? SURFACES.graphite;
    this.density = new Float32Array(ctx.width * ctx.height);
    this.paper = paperField(this.surf.paper, ctx.width, ctx.height);
  }

  private footprintFor(inp: BrushInput): Footprint {
    const s = this.surf;
    // a light touch narrows the mark to a third of its low-pressure width
    const r = inp.size * pressureCurve(inp.pressure, { from: s.radiusLow * 0.35, to: 1, gamma: 1.1 });
    const rx = r * (1 + TILT_STRETCH * inp.tilt);
    const ry = r * (1 - 0.15 * inp.tilt);
    return roundFootprint(inp.x, inp.y, rx, ry, inp.azimuth, s.plateau);
  }

  spacing(inp: BrushInput): number {
    const fp = this.footprintFor(inp);
    return Math.max(MIN_SPACING, SPACING_OF_RADIUS * Math.min(fp.hx, fp.hy)) * inp.spacing;
  }

  dab(inp: BrushInput): void {
    const s = this.surf;
    const fp = this.footprintFor(inp);
    // a dynamics taper can bring the footprint to nothing
    if (!(fp.hx > 0 && fp.hy > 0)) return;
    const b = footprintBounds(fp, this.ctx.width, this.ctx.height);
    if (!b) return;
    this.paper.fill(b.x0, b.y0, b.x1, b.y1);

    const spacing = Math.max(MIN_SPACING, SPACING_OF_RADIUS * Math.min(fp.hx, fp.hy)) * inp.spacing;
    const chord = chordIntegral(fp, inp.tangent.x, inp.tangent.y);
    // a tap deposits what one pass through its centre would
    let ds = inp.ds;
    if (inp.first) ds = inp.remaining === 0 ? chord : spacing * 0.5;
    if (ds <= 0) return;

    const fast = smoothstep(0, SPEED_SPAN, inp.velocity);
    const speedGain = mix(SPEED_SLOW_GAIN, SPEED_FAST_GAIN, fast);
    const amount = pressureCurve(inp.pressure, AMOUNT);
    const weight = ((s.density * this.ctx.intensity * amount * speedGain * ds) / chord) * inp.flow * inp.opacity;
    if (weight <= 0) return;

    const W = this.ctx.width;
    const D = this.density;
    const base = this.ctx.baseline;
    const H = this.paper.data;
    const tx = inp.tangent.x, ty = inp.tangent.y;
    // stroke frame: `w` is the offset across the path, `s` the distance along it
    const s0 = inp.distance;
    const tiltPress = 1 - TILT_LIGHTEN * inp.tilt;
    const lengthen = s.speedSparse * fast;
    const softW = s.soft;
    let streakAmt = s.streak;
    const across = s.across, along = s.along;
    const burnish = s.burnish;
    let dust = s.dust;
    if (inp.texture !== 1) {
      streakAmt *= inp.texture;
      dust = Math.min(1, Math.max(0, 1 - (1 - dust) * inp.texture));
    }

    for (let y = b.y0; y < b.y1; y++) {
      const qy = y + 0.5;
      const rely = qy - fp.cy;
      let i = y * W + b.x0;
      for (let x = b.x0; x < b.x1; x++, i++) {
        const qx = x + 0.5;
        const k = kernel(fp, qx, qy);
        if (k <= 0) continue;

        // local contact pressure: highest at the middle of the footprint
        const pe = inp.pressure * tiltPress * (1 - ENVELOPE + ENVELOPE * k);
        let reach = mix(s.reachLow, s.reachHigh, pressureCurve(pe, REACH)) - lengthen;

        // bristle / fibre streaks, in stroke space
        if (streakAmt > 0) {
          const relx = qx - fp.cx;
          const w = -relx * ty + rely * tx;
          const a = relx * tx + rely * ty;
          const n =
            0.75 * gradNoise2(w * across + 17.3, (s0 + a) * along, BRISTLE_SEED) +
            0.25 * gradNoise2(w * across * 2.3 + 3.1, (s0 + a) * along * 2.1, BRISTLE_SEED + 1);
          reach += streakAmt * 1.6 * n;
        }

        // material already here fills the tooth: valleys rise toward the peaks
        const filled = base[i * 4 + 3] + (1 - base[i * 4 + 3]) * (D[i] > 0.5 ? 0.5 : D[i]);
        const h = H[i];
        const heff = h + (1 - h) * burnish * filled;

        // graded, not binary: a peak that only just touches leaves a trace, one
        // pressed deep leaves a full deposit — this is what makes the grain
        // continuous-tone instead of a stipple
        const depth = heff - (1 - reach);
        const contact = depth > -softW ? smoothstep(-softW, softW * 2, depth) : 0;
        // dust falls wherever the pen presses, tooth or not; it grows with pressure
        const level = contact * (1 - dust) + dust * (pe > 1 ? 1 : pe);
        if (level > 0) D[i] += weight * level * (0.4 + 0.6 * k);
      }
    }
    this.dirty.add(b.x0, b.y0, b.x1, b.y1);
  }

  settle(): void {
    /* dry powder: nothing flows after the pen lifts */
  }

  composite(target: RasterSurface, region: Rect): void {
    compositeDensity(target, this.density, region, this.ctx.color);
  }
}
