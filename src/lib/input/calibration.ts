/**
 * Pressure calibration: reported pressure → the pressure the brush feels.
 *
 *   p' = response( ends(p) )
 *
 *  - ENDS. A device with a floor (it never reports below 0.12 in contact, say)
 *    cannot reach a brush's lightest mark: its lightest touch draws a 12 %
 *    line. Only that end is reshaped: a smooth, monotone knee takes the floor
 *    down to 0 and joins the identity with a matching slope a short way in.
 *    Everything above stays exactly as reported — stretching the whole range
 *    instead would make medium strokes lighter than the hand meant on a device
 *    that only clamps its lowest readings. The floor comes from evidence
 *    (capabilities.ts).
 *    A CEILING (a device saturating at 0.9) is supported the same way for an
 *    explicit calibration, but not applied from evidence: mapping a clip to
 *    full pressure made every firm stroke heavier than the hand meant
 *    (brush:check §15), and what lies above a clip is lost either way.
 *  - RESPONSE is a monotone curve (curves.ts), identity unless one is set: the
 *    place a per-device or per-user pressure curve goes. Being continuous and
 *    monotone it can never introduce a dead zone, a step or a reversal.
 *
 * The identity calibration returns its input unchanged — the same number, not
 * a recomputed one — so a pen that needs nothing gets nothing.
 */

import { pressureCurve, type PressureCurve } from "@/lib/raster/brushes/curves";
import type { DeviceProfile } from "./types";

export interface PressureCalibration {
  /** Reported value that stands for the lightest touch (0 = none). */
  readonly floor: number;
  /** Reported value that stands for full pressure (1 = none). */
  readonly ceiling: number;
  /** Response after the ends are reshaped; null = identity. */
  readonly response: PressureCurve | null;
}

export const IDENTITY_CALIBRATION: PressureCalibration = { floor: 0, ceiling: 1, response: null };

export function isIdentity(c: PressureCalibration): boolean {
  return c.floor === 0 && c.ceiling === 1 && !c.response;
}

/** The calibration a profile calls for (its floor), plus an optional
 *  response curve. */
export function calibrationFor(profile: DeviceProfile, response: PressureCurve | null = null): PressureCalibration {
  const floor = profile.floor > 0 && profile.floor < 0.5 ? profile.floor : 0;
  return { floor, ceiling: 1, response };
}

/** How far into the range a knee reaches: at least this much… */
const KNEE_MIN = 0.08;

/**
 * Cubic Hermite from (x0, y0) slope s0 to (x1, y1) slope s1. With the slopes
 * used here (Fritsch–Carlson: each at most 3× the secant, both ≥ 0) it is
 * monotone and C¹ where it meets the identity.
 */
function knee(x: number, x0: number, y0: number, s0: number, x1: number, y1: number, s1: number): number {
  const w = x1 - x0;
  const t = (x - x0) / w, t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * s0 * w + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * s1 * w;
}

/** Calibrated pressure, 0..1. Continuous and non-decreasing in `p`. */
export function calibrate(p: number, c: PressureCalibration): number {
  if (c.floor === 0 && c.ceiling === 1 && !c.response) return p;
  const f = c.floor, k = c.ceiling;
  let t: number;
  // the two knees, narrowed if a device's usable range is too short for both
  const room = (k - f) / 2;
  const wf = f > 0 ? Math.min(Math.max(KNEE_MIN, f), room) : 0;
  const wk = k < 1 ? Math.min(Math.max(KNEE_MIN, 1 - k), room) : 0;
  if (p <= f) t = 0;
  else if (p >= k) t = 1;
  else if (wf > 0 && p < f + wf) {
    // (f, 0) → (f + wf, f + wf), meeting the identity with slope 1
    t = knee(p, f, 0, (f + wf) / wf, f + wf, f + wf, 1);
  } else if (wk > 0 && p > k - wk) {
    // (k − wk, k − wk) → (k, 1), leaving the identity with slope 1
    t = knee(p, k - wk, k - wk, 1, k, 1, (1 - k + wk) / wk);
  } else t = p;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return c.response ? pressureCurve(t, c.response) : t;
}
