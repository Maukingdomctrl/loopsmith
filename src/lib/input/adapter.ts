/**
 * The input adapter: one pointer event → one `PenSample`, every channel read.
 *
 * What it preserves, and why each matters:
 *  - POSITION: sub-pixel, through the caller's exact canvas → layer mapping
 *    (`PointerMapping.toLayer`), so a stroke lands where it always has.
 *  - PRESSURE: the reported float, untouched. Whether it is real pressure, and
 *    what the device's quantization, noise or floor make of it, is decided
 *    later from evidence (capabilities.ts), never here.
 *  - TILT AND LEAN DIRECTION: from `altitudeAngle` / `azimuthAngle` where the
 *    platform provides them — they are doubles in radians — and only otherwise
 *    from `tiltX` / `tiltY`, which the Pointer Events spec makes whole degrees.
 *    The lean direction is carried into LAYER space, so a tilted brush keeps
 *    its orientation on a rotated view or layer.
 *  - TWIST, CONTACT SIZE, TANGENTIAL PRESSURE: read when reported.
 *  - TIME: strictly increasing (see `TimeRepair`).
 *
 * Pure reads into a reused record: no allocation per sample, no DOM access
 * beyond the event itself.
 */

import type { Vec2 } from "@/types/geometry";
import type { PenSample, PointerKind } from "./types";

/** The parts of a PointerEvent the adapter reads (a native event qualifies). */
export interface PointerLike {
  readonly pointerType: string;
  readonly clientX: number;
  readonly clientY: number;
  readonly pressure: number;
  readonly timeStamp: number;
  readonly tiltX?: number;
  readonly tiltY?: number;
  readonly twist?: number;
  readonly width?: number;
  readonly height?: number;
  readonly tangentialPressure?: number;
  /** Pointer Events level 3: radians, doubles. */
  readonly altitudeAngle?: number;
  readonly azimuthAngle?: number;
}

/** How client coordinates and directions reach the painted layer. */
export interface PointerMapping {
  /** Client px → layer px, or null when the layer cannot be mapped. */
  toLayer(clientX: number, clientY: number): Vec2 | null;
  /** Linear part of the canvas → layer matrix (the layer matrix inverted). */
  readonly inv: { readonly a: number; readonly b: number; readonly c: number; readonly d: number };
  /** View rotation, degrees (the stage is rotated by it on screen). */
  readonly viewRotation: number;
}

const HALF_PI = Math.PI / 2;

export function pointerKind(type: string): PointerKind {
  return type === "pen" ? "pen" : type === "touch" ? "touch" : "mouse";
}

/**
 * Fill `out` from `ev`. Returns false (and leaves `out` unspecified) when the
 * position cannot be mapped into the layer.
 *
 * `tilt` is the angle from the surface normal, `π/2 − altitude`; for a pen
 * held upright it is exactly 0, and so is its lean direction.
 */
export function readPointer(ev: PointerLike, map: PointerMapping, out: PenSample): boolean {
  const p = map.toLayer(ev.clientX, ev.clientY);
  if (!p) return false;
  out.x = p.x;
  out.y = p.y;
  out.clientX = ev.clientX;
  out.clientY = ev.clientY;
  out.time = ev.timeStamp;
  out.pressure = ev.pressure;

  let altitude: number;
  let screenAz: number;
  if (typeof ev.altitudeAngle === "number" && typeof ev.azimuthAngle === "number") {
    altitude = ev.altitudeAngle;
    screenAz = ev.azimuthAngle;
  } else {
    const tx = Math.tan(((ev.tiltX || 0) * Math.PI) / 180);
    const ty = Math.tan(((ev.tiltY || 0) * Math.PI) / 180);
    const lean = Math.hypot(tx, ty);
    altitude = lean > 0 ? Math.atan(1 / lean) : HALF_PI;
    screenAz = Math.atan2(ty, tx);
  }
  out.tilt = HALF_PI - altitude;
  out.screenAzimuth = screenAz;
  // Screen direction → canvas (undo the view rotation) → layer space.
  const va = screenAz - (map.viewRotation * Math.PI) / 180;
  const dx = Math.cos(va);
  const dy = Math.sin(va);
  const { a, b, c, d } = map.inv;
  out.azimuth = Math.atan2(b * dx + d * dy, a * dx + c * dy);

  out.twist = ((ev.twist || 0) * Math.PI) / 180;
  out.width = ev.width || 0;
  out.height = ev.height || 0;
  out.tangential = ev.tangentialPressure || 0;
  return true;
}

/**
 * Timestamps, made strictly increasing within a stroke.
 *
 * Some platforms give every coalesced event of a frame the same timestamp, or
 * coarsen timestamps to a millisecond, so a 500 Hz pen reports several samples
 * at one instant. Velocity and the pressure filter would then see an infinite
 * speed or a zero interval. A run of samples that does not advance in time is
 * spread evenly over the interval it must have come from; timestamps that
 * already increase are returned exactly as given.
 */
export class TimeRepair {
  private last = -Infinity;

  reset(): void {
    this.last = -Infinity;
  }

  /**
   * Repair one batch in place (`times[0..n)`, in report order). A batch is the
   * coalesced samples of one event: what the platform delivered together.
   * Returns how many timestamps it had to move (0 for a well-behaved device).
   */
  batch(times: Float64Array, n: number): number {
    let ok = true;
    let prev = this.last;
    for (let i = 0; i < n; i++) {
      if (!(times[i] > prev)) { ok = false; break; }
      prev = times[i];
    }
    if (ok) {
      if (n > 0) this.last = times[n - 1];
      return 0;
    }
    // The batch ends at its latest timestamp; its samples are spread evenly
    // between the previous sample and that end.
    let end = -Infinity;
    for (let i = 0; i < n; i++) if (times[i] > end) end = times[i];
    const start = this.last;
    if (!(end > start)) end = Number.isFinite(start) ? start + n * MIN_GAP_MS : end;
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const t = Number.isFinite(start) ? start + ((end - start) * (i + 1)) / n : end - (n - 1 - i) * MIN_GAP_MS;
      if (t !== times[i]) moved++;
      times[i] = t;
    }
    this.last = times[n - 1];
    return moved;
  }
}

/** Gap given to samples that arrive with no time between them at all. */
const MIN_GAP_MS = 0.25;
