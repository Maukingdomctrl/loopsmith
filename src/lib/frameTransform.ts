/**
 * The single composition point for L1 ⊕ L2.
 *
 *     R_i = (x_i, y_i) + (Δ_i) · fitScale · zoom_i
 *
 * Every consumer that puts pixels on a surface MUST obtain its transform here.
 * There are four such consumers (base layer, onion skin, playback, GIF export)
 * and the previous architecture had each of them reading frame.x/y directly —
 * which meant adding a second layer required four correct edits instead of one.
 */

import type { Frame } from "@/types/frame";
import { ZERO_STABILIZATION } from "@/types/frame";

import { containScale } from "@/lib/geometry/rect";
import { poseToLegacy } from "@/lib/layers/migrate";
import { layerMatrix } from "@/lib/layers/layerSpace";

import type { Mat2D } from "@/types/geometry";

export const CANVAS_SIZE = 512;

/** What a renderer actually needs. Note the absence of `stab`: by the time a
 *  draw call sees this, the layers are already composed and the distinction is
 *  no longer meaningful. Keeping `stab` out of the type makes it impossible for
 *  a renderer to compose twice. */
export type RenderTransform = {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  readonly rotation: number;
};

export const IDENTITY_TRANSFORM: RenderTransform = {
  x: 0,
  y: 0,
  zoom: 1,
  rotation: 0,
};

/**
 * "Contain" fit of a source bitmap into a square surface. Shared by
 * frameTransform and drawFrame so the two can never disagree — a disagreement
 * here is a silent scale error, the single most expensive class of bug in this
 * codebase (it produces plausible-looking output that is wrong by a constant).
 */
export function fitScale(
  sourceWidth: number,
  sourceHeight: number,
  surface: number = CANVAS_SIZE
): number {
  return containScale(sourceWidth, sourceHeight, surface, surface);
}

/**
 * Source px → canvas px, for a given frame's zoom.
 *
 * Contains `zoom` because drawFrameToCanvas translates BEFORE it scales: one
 * source pixel spans fitScale · zoom canvas px. For a 128 px cell on a 512
 * surface at zoom 1 this is 4 — so writing raw solver output into frame.x/y
 * under-corrects by exactly 4×, which is the arithmetic behind symptom 2.
 */
export function sourceToCanvasScale(
  sourceWidth: number,
  sourceHeight: number,
  zoom: number,
  surface: number = CANVAS_SIZE
): number {
  return fitScale(sourceWidth, sourceHeight, surface) * zoom;
}

/** R = L1 ⊕ L2. `sourceWidth/Height` come from the decoded bitmap at the call site. */
export function renderTransform(
  frame: Frame,
  sourceWidth: number,
  sourceHeight: number,
  surface: number = CANVAS_SIZE
): RenderTransform {
  const stab = frame.stab ?? ZERO_STABILIZATION;

  // Fast path: no correction, so no scale lookup and no float noise.
  if (stab.dx === 0 && stab.dy === 0) {
    return { x: frame.x, y: frame.y, zoom: frame.zoom, rotation: frame.rotation };
  }

  const s = sourceToCanvasScale(sourceWidth, sourceHeight, frame.zoom, surface);
  return {
    x: frame.x + stab.dx * s,
    y: frame.y + stab.dy * s,
    zoom: frame.zoom,
    rotation: frame.rotation,
  };
}

/** Both layers neutral. Independent of source size: with x = 0, x + Δ·s = 0
 *  forces Δ = 0 for any s > 0, so no dimension argument is needed. */
export function isIdentityTransform(frame: Frame): boolean {
  const stab = frame.stab ?? ZERO_STABILIZATION;
  return (
    frame.x === 0 &&
    frame.y === 0 &&
    frame.zoom === 1 &&
    frame.rotation === 0 &&
    stab.dx === 0 &&
    stab.dy === 0
  );
}

/**
 * Can the lasso bake this frame without meaningful loss?
 *
 * NOT the same as identity. The bake reads back the composed base canvas, so
 * translation — including a sub-pixel stabilization offset — flattens correctly
 * at the cost of one bilinear resample. Only zoom and rotation degrade the
 * bitmap in a way the animator would notice. Gating on identity instead would
 * disable the lasso across the whole project the moment Auto Stabilize runs.
 */
export function isBakeable(frame: Frame): boolean {
  const base = frame.layers?.find((l) => l.kind === "base");
  if (!base) return frame.zoom === 1 && frame.rotation === 0;

  const legacy = poseToLegacy(base.pose, base.size.w || 1, base.size.h || 1);
  if (!legacy) return false;

  return Math.abs(legacy.zoom - 1) < 1e-6 && legacy.rotation === 0;
}

/** Collapse L1 ⊕ L2 into L0. The ONLY destructive path (lasso bake). Both
 *  layers must be zeroed together — zeroing only L1 would re-apply the
 *  correction to already-corrected pixels on the next render. */
export function clearTransforms(frame: Frame): Frame {
  return {
    ...frame,
    x: 0,
    y: 0,
    zoom: 1,
    rotation: 0,
    stab: ZERO_STABILIZATION,
  };
}

/* ---------------- migration ---------------- */

/** Backfill L2 on projects persisted before it existed. Applied at every
 *  deserialization boundary (IndexedDB restore, history restore) so no
 *  downstream code needs a null check on `stab`. */
export function normalizeFrame(frame: Frame): Frame {
  return frame.stab ? frame : { ...frame, stab: ZERO_STABILIZATION };
}

export function normalizeFrames(frames: readonly Frame[]): Frame[] {
  let changed = false;
  const out = frames.map((f) => {
    const n = normalizeFrame(f);
    if (n !== f) changed = true;
    return n;
  });
  return changed ? out : (frames as Frame[]);
}

export function baseLayerMatrix(frame: Frame): Mat2D | null {
  const base = frame.layers?.find((l) => l.kind === "base");
  if (!base) return null;

  const stab = frame.stab ?? ZERO_STABILIZATION;
  if (stab.dx === 0 && stab.dy === 0) return layerMatrix(base);

  const m = layerMatrix(base);
  return {
    ...m,
    e: m.e + stab.dx * Math.abs(base.pose.scale.x),
    f: m.f + stab.dy * Math.abs(base.pose.scale.y),
  };
}

export function isFlatDocument(frame: Frame): boolean {
  return frame.layers.filter((l) => l.image).length <= 1 && frame.crop === null;
}