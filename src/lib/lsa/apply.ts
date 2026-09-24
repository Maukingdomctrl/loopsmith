/**
 * LSA v1.0 — assign the L2 correction layer.
 *
 * IDEMPOTENT BY CONSTRUCTION, and that is the entire justification for L2's
 * existence. The solver measures frame.image, which is invariant to frame.x/y,
 * so it returns the same c_i on every run.
 *
 * ANCHOR GAUGE: the solver produces corrections in a mean gauge (Σ t̂ = 0).
 * We rebase onto the first frame that has an image so that frame becomes the
 * fixed base layer (stab = {0,0}) and every other frame is expressed relative
 * to it — the Procreate model: base holds still, top layers only move.
 * The rebase is a pure translation of the reference point; all relative motion
 * between frames is unchanged, so the solve itself is never touched.
 *
 * NO COORDINATE CONVERSION HERE. `stab` is stored in the solver's own
 * source-pixel units and converted at the render boundary by
 * lib/frameTransform.ts.
 */

import type { LSAResult } from "./types";

export interface StabilizableFrame {
  readonly stab: { readonly dx: number; readonly dy: number };
  readonly image?: string | null;
}

/** Assign c_i into L2, rebased onto the first frame-with-image as the anchor.
 *  Returns the SAME object for frames whose correction is unchanged, so React
 *  can skip re-rendering untouched timeline cells. */
export function assignStabilization<T extends StabilizableFrame>(
  frames: readonly T[],
  result: LSAResult
): T[] {
  const anchorIndex = frames.findIndex((f) => f.image);
  const a = anchorIndex >= 0 ? result.translations[anchorIndex] : null;

  return frames.map((frame, i) => {
    const c = result.translations[i];
    if (!c) return frame;

    const dx = a && i !== anchorIndex ? c.dx - a.dx : 0;
    const dy = a && i !== anchorIndex ? c.dy - a.dy : 0;

    const cur = frame.stab;
    if (cur && cur.dx === dx && cur.dy === dy) return frame;

    return { ...frame, stab: { dx, dy } };
  });
}

/** Discard all machine correction. L1 is untouched, so the animator's manual
 *  posing survives — "undo the robot" without "undo my work". */
export function clearStabilization<T extends StabilizableFrame>(
  frames: readonly T[]
): T[] {
  return frames.map((frame) => {
    const cur = frame.stab;
    if (cur && cur.dx === 0 && cur.dy === 0) return frame;
    return { ...frame, stab: { dx: 0, dy: 0 } };
  });
}

/**
 * Scale the correction toward zero — the "stabilization strength" slider.
 *
 * Mathematically legitimate because c = −Π t̂ is linear in t̂, so αc is the
 * correction that would result from attenuating every retained harmonic by α.
 */
export function scaleStabilization<T extends StabilizableFrame>(
  frames: readonly T[],
  result: LSAResult,
  strength: number
): T[] {
  const a = Math.max(0, Math.min(1, strength));
  return frames.map((frame, i) => {
    const c = result.translations[i];
    if (!c) return frame;
    return { ...frame, stab: { dx: c.dx * a, dy: c.dy * a } };
  });
}
