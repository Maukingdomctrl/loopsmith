/**
 * A pointer sample as the pencil records it (types.ts: PENCIL_STRIDE values).
 *
 * The input layer (lib/input) has already read every channel and decided,
 * from evidence, what the device's pressure means; this is only the pencil's
 * own reading of it:
 *  - pressure is the stroke's real pressure, or a fixed medium touch for a
 *    device that has none;
 *  - tilt ignores the first ~10° of lean (a pen is never held perfectly
 *    upright) and reaches 1 at about 60°;
 *  - only a pen leans: other pointers record tilt and lean direction as 0.
 */

import type { PenSample, PointerKind } from "@/lib/input/types";
import { PENCIL_STRIDE } from "./types";

/** Pressure a device without pressure (a mouse, a finger) draws with. */
export const MOUSE_PRESSURE = 0.62;

/** Lean ignored as "upright", and the lean range that maps onto tilt 0..1. */
const TILT_DEAD = 0.17;
const TILT_RANGE = 0.87;

/**
 * Write one sample's PENCIL_STRIDE values into `out` (reused by the caller):
 * layer-space position, pressure, tilt, lean direction (layer space), barrel
 * twist, and time since the stroke began.
 */
export function pencilValues(
  s: PenSample, kind: PointerKind, hasPressure: boolean, t0: number, out: number[]
): number[] {
  out.length = PENCIL_STRIDE;
  const pen = kind === "pen";
  out[0] = s.x;
  out[1] = s.y;
  out[2] = hasPressure ? s.pressure : MOUSE_PRESSURE;
  out[3] = pen ? Math.min(1, Math.max(0, (s.tilt - TILT_DEAD) / TILT_RANGE)) : 0;
  out[4] = pen ? s.azimuth : 0;
  out[5] = s.twist;
  out[6] = s.time - t0;
  return out;
}
