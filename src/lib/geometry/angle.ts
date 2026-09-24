/**
 * The 0–360° angle system.
 *
 * INVARIANT: every angle that is stored, displayed, or persisted is in
 * [0, 360). Every angle that represents a *difference* is in (-180, 180].
 * Conflating the two is what produces a layer that spins the long way round
 * when dragged across the 0/360 seam.
 */

import { ANGLE_EPS } from "@/types/geometry";
import type { Vec2 } from "@/types/geometry";
import { clamp } from "./scalar";

export const DEG_PER_RAD = 180 / Math.PI;
export const RAD_PER_DEG = Math.PI / 180;

export const degToRad = (d: number): number => d * RAD_PER_DEG;
export const radToDeg = (r: number): number => r * DEG_PER_RAD;

/**
 * Canonical storage form: [0, 360).
 *
 * Note the snap-to-integer-degree step: without it, repeatedly adding 0.1°
 * 3600 times lands on 359.9999999999 and the UI shows "360°", which is not a
 * legal value in this system. The snap only fires within ANGLE_EPS, so it can
 * never move a genuine 359.9999 the user typed.
 */
export function normalizeAngle(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  let a = deg % 360;
  if (a < 0) a += 360;
  if (a >= 360 - ANGLE_EPS) a = 0;
  const near = Math.round(a);
  if (Math.abs(a - near) <= ANGLE_EPS) a = near % 360;
  return a;
}

/** Canonical difference form: (-180, 180]. The rotation a handle drag should
 *  actually apply. */
export function angleDelta(from: number, to: number): number {
  let d = (normalizeAngle(to) - normalizeAngle(from)) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d === 0 ? 0 : d;
}

/** Unsigned separation in [0, 180]. */
export const angleSeparation = (a: number, b: number): number =>
  Math.abs(angleDelta(a, b));

export const anglesEqual = (a: number, b: number, tol = ANGLE_EPS): boolean =>
  angleSeparation(a, b) <= tol;

/** Angle of a vector, in the canonical 0–360 storage form. */
export const angleOfVector = (v: Vec2): number =>
  normalizeAngle(radToDeg(Math.atan2(v.y, v.x)));

/** Angle from `from` to `to` about `pivot`. Used by the rotation handle. */
export const angleBetweenPoints = (pivot: Vec2, p: Vec2): number =>
  angleOfVector({ x: p.x - pivot.x, y: p.y - pivot.y });

/** Snap to the nearest multiple of `step`, staying in [0, 360). step ≤ 0 is a
 *  no-op so the caller can pass a user setting straight through. */
export function snapAngle(deg: number, step: number): number {
  if (!(step > 0)) return normalizeAngle(deg);
  return normalizeAngle(Math.round(normalizeAngle(deg) / step) * step);
}

/** Snap only when already within `tolerance` of a multiple — "magnetic"
 *  snapping that does not fight the user mid-drag. */
export function magneticSnapAngle(
  deg: number,
  step: number,
  tolerance: number
): number {
  if (!(step > 0)) return normalizeAngle(deg);
  const snapped = snapAngle(deg, step);
  return angleSeparation(deg, snapped) <= tolerance ? snapped : normalizeAngle(deg);
}

/**
 * Straighten: the rotation that makes the segment a→b horizontal.
 *
 * Returns a DELTA in (-180, 180], and folds the result into (-90, 90] because
 * a horizon drawn right-to-left means the same horizon — without that fold,
 * straightening with a backwards-drawn line flips the artwork upside down.
 */
export function straightenDeltaHorizontal(a: Vec2, b: Vec2): number {
  const raw = radToDeg(Math.atan2(b.y - a.y, b.x - a.x));
  let d = -raw;
  while (d > 90) d -= 180;
  while (d <= -90) d += 180;
  return Math.abs(d) <= ANGLE_EPS ? 0 : d;
}

/** Same, for a line the user intends to be vertical. */
export function straightenDeltaVertical(a: Vec2, b: Vec2): number {
  return straightenDeltaHorizontal(
    { x: 0, y: 0 },
    { x: b.y - a.y, y: -(b.x - a.x) }
  );
}

/** Clamp a value the user typed into a rotation field. Accepts 0–360 and
 *  wraps anything else rather than rejecting it. */
export const parseAngleInput = (raw: string, fallback: number): number => {
  const v = Number(raw.trim().replace(/°$/, ""));
  return Number.isFinite(v) ? normalizeAngle(v) : normalizeAngle(fallback);
};

/** Percent-style clamp used by the opacity field; here because it shares the
 *  same "user typed into a bounded field" contract. */
export const clamp01 = (v: number): number => clamp(v, 0, 1);
