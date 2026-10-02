/**
 * Frame lifecycle operations. Pure; no React, no storage.
 */
import { type Frame, ZERO_STABILIZATION } from "@/types/frame";
import { createBaseLayer, createLayerId } from "@/lib/layers/layerOps";

/** Collision-resistant and monotonic, so ids sort by creation for debugging. */
let sequence = 0;
export function createFrameId(): string {
  sequence += 1;
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `f_${Date.now().toString(36)}_${sequence.toString(36)}_${rand}`;
}

export function createBlankFrame(): Frame {
  const base = createBaseLayer();

  return {
    id: createFrameId(),
    image: null,
    duration: 1,
    x: 0,
    y: 0,
    zoom: 1,
    rotation: 0,
    stab: ZERO_STABILIZATION,

    layers: [base],
    activeLayerId: base.id,
    crop: null,
    flattenKey: null,
    flattenedAt: 0,
    legacyPosePending: false,
  };
}

/**
 * Duplicate a frame.
 *
 * NEW ID, always — the reducer in page.tsx is id-keyed, so a shared id would
 * make both copies respond to the same edit.
 *
 * L2 IS COPIED. The duplicate has identical pixels, so the identical correction
 * applies; copying it keeps the duplicate visually indistinguishable from its
 * source, which is what "duplicate" means. Dropping it would make the copy jump.
 */
export function duplicateFrame(frame: Frame): Frame {
  const remap = new Map<string, string>();

  const layers = frame.layers.map((l) => {
    const id = createLayerId();
    remap.set(l.id, id);

    return {
      ...l,
      id,
      pose: { ...l.pose },
      crop: l.crop ? { ...l.crop } : null,
    };
  });

  // Groups point at their new ids too.
  const relinked = layers.map((l) =>
    l.parentId ? { ...l, parentId: remap.get(l.parentId) ?? l.parentId } : l
  );

  return {
    ...frame,
    id: createFrameId(),
    stab: { ...(frame.stab ?? ZERO_STABILIZATION) },
    layers: relinked,
    activeLayerId: remap.get(frame.activeLayerId) ?? layers[0].id,
    crop: frame.crop ? { ...frame.crop } : null,

    // The composite is unchanged, but layer ids changed.
    flattenKey: null,
  };
}

export interface DeleteResult {
  readonly frames: Frame[];
  /** Index to select afterwards. Clamped, never negative. */
  readonly nextIndex: number;
}

export function deleteFrame(
  frames: readonly Frame[],
  index: number
): DeleteResult {
  if (frames.length <= 1) {
    return { frames: [createBlankFrame()], nextIndex: 0 };
  }
  const safe = Math.max(0, Math.min(index, frames.length - 1));
  const next = frames.filter((_, i) => i !== safe);
  return { frames: next, nextIndex: Math.min(safe, next.length - 1) };
}

/**
 * Move a frame. `to` is the insertion slot in the ORIGINAL indexing, so the
 * caller does not have to reason about whether removal shifted the target —
 * the off-by-one that this convention eliminates is the one that silently
 * reorders by two positions when dragging rightwards.
 */
export function reorderFrames(
  frames: readonly Frame[],
  from: number,
  to: number
): { frames: Frame[]; insertedAt: number } {
  if (from === to || from < 0 || from >= frames.length) {
    return { frames: [...frames], insertedAt: from };
  }
  const next = [...frames];
  const [moved] = next.splice(from, 1);
  const insertAt = from < to ? to - 1 : to;
  const clamped = Math.max(0, Math.min(insertAt, next.length));
  next.splice(clamped, 0, moved);
  return { frames: next, insertedAt: clamped };
}

/**
 * Move a block of frames, kept in their order, to insertion slot `slot`
 * (same ORIGINAL-indexing convention as reorderFrames). `insertedAt` is where
 * the block starts afterwards.
 */
export function moveFrames(
  frames: readonly Frame[],
  ids: readonly string[],
  slot: number
): { frames: Frame[]; insertedAt: number } {
  const moving = new Set(ids);
  const block = frames.filter((f) => moving.has(f.id));
  if (!block.length) return { frames: [...frames], insertedAt: 0 };
  const before = frames.slice(0, slot).filter((f) => !moving.has(f.id));
  const after = frames.slice(slot).filter((f) => !moving.has(f.id));
  return { frames: [...before, ...block, ...after], insertedAt: before.length };
}

/** L2 must survive reordering unchanged: the correction belongs to the frame's
 *  pixels, not to its position. Re-running Auto Stabilize after a reorder will
 *  produce a DIFFERENT solve (the temporal graph changed), which is correct —
 *  but it must be the animator's choice, not a side effect of dragging. */
export function framesEqualIgnoringOrder(
  a: readonly Frame[],
  b: readonly Frame[]
): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((f) => f.id));
  return b.every((f) => ids.has(f.id));
}
