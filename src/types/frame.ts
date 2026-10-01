/**
 * Frame — the L0/L1/L2 layer model.
 *
 * Lives in types/ rather than components/Canvas.tsx so that lib/ code can
 * reference a Frame without importing a React component. The previous
 * arrangement (Frame exported from Canvas) is why every lib file that needed
 * the shape had to either re-declare it structurally or reach into components/.
 */

import type { Layer, DocumentCrop } from "@/types/layer";

/**
 * L2 — machine-owned stabilization correction, in SOURCE-BITMAP pixels.
 *
 * Solver-native units, deliberately. The conversion to canvas px is
 *
 *     (CANVAS_SIZE / cellWidth) · zoom
 *
 * which CONTAINS zoom, so a correction frozen in canvas-px units becomes wrong
 * the moment the animator changes zoom. Storing it in source px keeps it
 * invariant to both zoom and canvas resolution; composition happens at the
 * render boundary, where cellWidth is known (lib/frameTransform.ts).
 */
export interface StabilizationOffset {
  readonly dx: number;
  readonly dy: number;
}

export const ZERO_STABILIZATION: StabilizationOffset = { dx: 0, dy: 0 };

export type Frame = {
  /** Stable identity. Never derive storage or history keys from array position. */
  id: string;

  /**
   * L0 — the FLATTEN CACHE. Still the frame's pixels for every existing
   * consumer (timeline thumbnail, GIF export, LSA content hash), but now
   * derived from `layers` by lib/layers/flatten.ts rather than authored
   * directly. Keeping the field is what lets the stabilizer and exporter run
   * unchanged.
   */
  image: string | null;

  /** Playback hold, in frame ticks. */
  duration: number;

  /* ---- L1: animator-owned absolute pose, canvas px, applied pre-scale ---- */
  x: number;
  y: number;
  zoom: number;
  rotation: number;
  

  /**
   * L2 — machine-owned. NEVER written by manual editing; assigned wholesale by
   * Auto Stabilize. This separation is what makes stabilization idempotent:
   * the solver reads pixels, which are invariant to L1, so it returns the same
   * correction on every run. Assigning cannot double-apply; accumulating into
   * L1 provably would.
   */
  stab: StabilizationOffset;

  /* ---- layer system ---- */

  /** Bottom-to-top. layers[0] is always the permanent base layer. */
  layers: Layer[];

  /** Where an import lands and what the transform panel edits by default. */
  activeLayerId: string;

  /** Canvas-space document crop. null = full surface. */
  crop: DocumentCrop | null;

  /** layerStateKey() of the layers `image` was composited from. */
  flattenKey: string | null;

  flattenedAt: number;

  /** True while a migrated frame is waiting for its bitmap size. */
  legacyPosePending: boolean;
};

/** True when no machine correction is present anywhere in the sequence. */
export function hasStabilization(frames: readonly Frame[]): boolean {
  return frames.some(
    (f) => f.stab && (f.stab.dx !== 0 || f.stab.dy !== 0)
  );
}