/**
 * Pencil strokes are stored as physics, never as pixels.
 *
 * A stroke is the recorded motion of the pencil — position, pressure, tilt,
 * rotation and time for every input sample — in the layer's own float
 * coordinate space. Nothing is rounded to a pixel grid. The renderer rebuilds
 * the graphite analytically from this record at whatever resolution it is
 * asked for (editor view, flatten cache, GIF export), so a stroke has no native
 * resolution and never degrades.
 */

/** Values per sample in `PencilStroke.pts`. */
export const PENCIL_STRIDE = 7;

/** Offsets within one sample. */
export const P_X = 0; //        layer px (float)
export const P_Y = 1; //        layer px (float)
export const P_PRESSURE = 2; // 0..1, full device precision (4096+ levels)
export const P_TILT = 3; //     0 = upright, 1 = lying on its side
export const P_AZIMUTH = 4; //  direction the pencil leans, radians, layer space
export const P_TWIST = 5; //    barrel rotation, radians
export const P_TIME = 6; //     ms since the stroke started

export type PencilStrokeKind = "graphite" | "erase";

export interface PencilStroke {
  readonly id: string;
  readonly kind: PencilStrokeKind;
  /** Graphite colour, #rrggbb. Ignored by erase strokes. */
  readonly color: string;
  /** Tip radius at full pressure, in layer px. Continuous; may be 0.01. */
  readonly size: number;
  /** Paper seed: every sheet has its own tooth. Copied on duplicate. */
  readonly seed: number;
  /** Flat samples, PENCIL_STRIDE numbers each. */
  readonly pts: readonly number[];
}

/** Smallest tip radius the tools offer: a 0.02 px wide line. */
export const PENCIL_MIN_SIZE = 0.01;
export const PENCIL_MAX_SIZE = 64;

let sequence = 0;
export function createStrokeId(): string {
  sequence += 1;
  return `s_${Date.now().toString(36)}_${sequence.toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 7)}`;
}

/** Stable 32-bit seed from any string (the layer id), FNV-1a. */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
