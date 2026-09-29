/**
 * Soft Round and Soft Rectangle — the density-accumulating brushes.
 *
 * One model, two footprints. It behaves like a soft physical brush or an
 * airbrush resting on a surface:
 *
 *  - PRESSURE is deposit. A light touch leaves almost nothing; pressing
 *    lays down progressively more, through a continuous curve — there are no
 *    pressure steps anywhere.
 *  - Density is deposited per unit of TRAVEL, normalised by the footprint's
 *    chord integral, so one pass leaves the same centre density at any size,
 *    shape or direction, and it does not depend on how densely dabs happen to
 *    be placed along the curve.
 *  - The stroke is the integral of a bell-shaped kernel along the path, so its
 *    cross-section is centre-weighted: it never looks like a semi-transparent
 *    digital circle. Opacity is α = 1 − e^(−D), so a light pass is a faint
 *    haze, repeated passes build density, and a heavy pass saturates into a
 *    dense core with a feathered rim.
 *  - HARDER WITH PRESSURE. Pressure also grows a plateau in the kernel and
 *    shrinks the soft perimeter of the rectangle, so the same brush goes from
 *    airy to firm just by pressing.
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
  rectFootprint,
  roundFootprint,
  type Footprint,
} from "../footprint";
import { compositeDensity } from "./density";

/* ---------- tuning: every number the soft brushes are made of ---------- */

/** Density at the centre of ONE pass at full pressure and full intensity.
 *  α = 1 − e^(−3) ≈ 0.95: dense, but not yet a flat opaque fill. */
const DENSITY_MAX = 3;

/** Pressure → deposit. gamma ≈ 2 keeps a light touch almost invisible and
 *  leaves the middle of the range for "medium" (p = 0.5 lands near α = 0.4). */
const DEPOSIT: PressureCurve = { from: 0, to: 1, gamma: 2, ease: 0.12 };

/** Pressure → contact radius, as a fraction of the size. A light touch is a
 *  narrow, faint mark; pressing opens the brush to its full size. */
const CONTACT: PressureCurve = { from: 0.3, to: 1, gamma: 1 };

/** Pressure → plateau (round). Zero at a light touch (pure bell). */
const PLATEAU: PressureCurve = { from: 0, to: 0.2, gamma: 1.4 };

/** Pressure → rectangle soft perimeter, as a fraction of the short half-side. */
const RECT_SOFT: PressureCurve = { from: 0.9, to: 0.5, gamma: 1.2 };

/** Slow strokes lay down a little more, fast ones a little less (canvas px/ms). */
const SPEED_SLOW_GAIN = 1.3;
const SPEED_FAST_GAIN = 0.65;
const SPEED_SPAN = 2.2;

/** Dab spacing as a fraction of the SOFT width of the footprint. The bell's σ is
 *  0.33 of that width, so this keeps spacing below σ, where the ripple of the
 *  summed dabs is smaller than an 8-bit quantum. */
const SPACING_OF_SOFT = 0.28;
const MIN_SPACING = 0.3;

/** Pen tilt: a leaning pen presses a longer contact patch. */
const TILT_STRETCH = 1.4;
const TILT_SHRINK = 0.2;

interface Dab {
  readonly fp: Footprint;
  readonly gain: number;
  /** Width of the soft perimeter, px — sets the spacing. */
  readonly softWidth: number;
}

export class SoftModel implements BrushModel {
  readonly dirty = new DirtyTracker();
  private readonly density: Float32Array;
  private readonly ctx: ModelContext;

  constructor(ctx: ModelContext) {
    this.ctx = ctx;
    this.density = new Float32Array(ctx.width * ctx.height);
  }

  /** The footprint this input would stamp. */
  private shapeFor(inp: BrushInput): Dab {
    const R = inp.size;
    const p = inp.pressure;

    if (this.ctx.shape === "rect") {
      const hy = Math.max(0.6, R * pressureCurve(p, CONTACT));
      const hx = hy * this.ctx.aspect;
      const soft = Math.max(0.3, hy * pressureCurve(p, RECT_SOFT));
      return {
        fp: rectFootprint(inp.x, inp.y, hx, hy, inp.rotation, soft),
        gain: 1,
        softWidth: Math.min(soft, hy),
      };
    }

    const r0 = R * pressureCurve(p, CONTACT);
    const { radius, gain } = pixelSafeRadius(r0);
    const plateau = pressureCurve(p, PLATEAU);
    // a leaning pen presses an ellipse whose long axis lies along the lean
    const rx = radius * (1 + TILT_STRETCH * inp.tilt);
    const ry = radius * (1 - TILT_SHRINK * inp.tilt);
    return {
      fp: roundFootprint(inp.x, inp.y, rx, ry, inp.azimuth, plateau),
      gain,
      softWidth: (1 - plateau) * Math.min(rx, ry),
    };
  }

  spacing(inp: BrushInput): number {
    const { softWidth } = this.shapeFor(inp);
    return Math.max(MIN_SPACING, SPACING_OF_SOFT * softWidth);
  }

  dab(inp: BrushInput): void {
    const { fp, gain, softWidth } = this.shapeFor(inp);

    // Deposit weight: rate per px of travel × px travelled. The first dab has
    // no travel yet, so it gets half a spacing (the stroke's cap). A tap — a
    // stroke that never moved — deposits what one pass through its centre
    // would (`chord` px of travel), so a click leaves a real mark, not a smudge.
    const spacing = Math.max(MIN_SPACING, SPACING_OF_SOFT * softWidth);
    const chord = chordIntegral(fp, inp.tangent.x, inp.tangent.y);
    let ds = inp.ds;
    if (inp.first) ds = inp.remaining === 0 ? chord : spacing * 0.5;
    if (ds <= 0) return;

    const speed = mix(
      SPEED_SLOW_GAIN, SPEED_FAST_GAIN, smoothstep(0, SPEED_SPAN, inp.velocity)
    );
    const rate =
      (DENSITY_MAX * this.ctx.intensity * pressureCurve(inp.pressure, DEPOSIT)) / chord;
    const weight = rate * ds * gain * speed;
    if (weight <= 0) return;

    this.deposit(fp, weight);
  }

  private deposit(fp: Footprint, weight: number): void {
    const b = footprintBounds(fp, this.ctx.width, this.ctx.height);
    if (!b) return;
    const w = this.ctx.width;
    const D = this.density;

    for (let y = b.y0; y < b.y1; y++) {
      let i = y * w + b.x0;
      for (let x = b.x0; x < b.x1; x++, i++) {
        const k = kernel(fp, x + 0.5, y + 0.5);
        if (k > 0) D[i] += weight * k;
      }
    }
    this.dirty.add(b.x0, b.y0, b.x1, b.y1);
  }

  settle(): void {
    /* nothing dries: density is final the moment it is laid down */
  }

  composite(target: RasterSurface, region: Rect): void {
    compositeDensity(target, this.density, region, this.ctx.color);
  }
}
