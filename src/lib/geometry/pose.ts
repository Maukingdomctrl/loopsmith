/**
 * Pose ⇄ matrix, and the pivot algebra.
 *
 * A Pose is the canonical, human-editable, serializable form of a layer's
 * transform:
 *
 *     M(pose) = T(position) · R(rotation) · S(scale) · T(-pivot)
 *
 * `position` is where the PIVOT lands in the parent space. That choice is what
 * makes the rotation dial and the pivot marker independent controls: changing
 * the pivot must not move the artwork, and changing rotation must not move the
 * pivot. Both fall out of the formula above for free.
 */

import type { Mat2D, Rect, Vec2 } from "@/types/geometry";
import {
  clampScale,
  matApply,
  matChain,
  matDecompose,
  matRotate,
  matScale,
  matTranslate,
} from "./mat2d";
import { normalizeAngle } from "./angle";
import { finiteOr } from "./scalar";
import { vec } from "./vec2";

export interface Pose {
  /** Canvas-space location of the pivot. */
  readonly position: Vec2;
  /** Degrees in [0, 360). */
  readonly rotation: number;
  readonly scale: Vec2;
  /** LOCAL-space pivot, in source pixels. */
  readonly pivot: Vec2;
}

export const IDENTITY_POSE: Pose = {
  position: { x: 0, y: 0 },
  rotation: 0,
  scale: { x: 1, y: 1 },
  pivot: { x: 0, y: 0 },
};

export function makePose(p: Partial<Pose>): Pose {
  return {
    position: p.position ?? IDENTITY_POSE.position,
    rotation: normalizeAngle(p.rotation ?? 0),
    scale: clampScale(p.scale ?? IDENTITY_POSE.scale),
    pivot: p.pivot ?? IDENTITY_POSE.pivot,
  };
}

/** Repair a pose that came from JSON, an older schema, or a NaN-producing
 *  interaction. Never throws: a broken pose must degrade to a visible layer,
 *  not to an unrenderable document. */
export function sanitizePose(raw: unknown): Pose {
  const p = (raw ?? {}) as Record<string, unknown>;
  const v = (o: unknown, dx: number, dy: number): Vec2 => {
    const r = (o ?? {}) as Record<string, unknown>;
    return vec(finiteOr(r.x, dx), finiteOr(r.y, dy));
  };
  return makePose({
    position: v(p.position, 0, 0),
    rotation: finiteOr(p.rotation, 0),
    scale: v(p.scale, 1, 1),
    pivot: v(p.pivot, 0, 0),
  });
}

export const poseToMatrix = (pose: Pose): Mat2D =>
  matChain(
    matTranslate(pose.position.x, pose.position.y),
    matRotate(pose.rotation),
    matScale(pose.scale.x, pose.scale.y),
    matTranslate(-pose.pivot.x, -pose.pivot.y)
  );

/**
 * Recover a pose from a matrix, keeping a chosen local pivot.
 *
 * Shear is DISCARDED here, by design: the transform tools never create one,
 * and silently keeping it would let a pose round-trip into a matrix the UI
 * cannot represent. `matDecompose` still reports it, so callers that care can
 * detect the loss.
 */
export function matrixToPose(m: Mat2D, pivotLocal: Vec2): Pose {
  const d = matDecompose(m);
  return makePose({
    position: matApply(m, pivotLocal),
    rotation: d.rotation,
    scale: d.scale,
    pivot: pivotLocal,
  });
}

/**
 * Move the pivot WITHOUT moving the artwork.
 *
 * The new position is simply where the new pivot currently renders. This is
 * exact for any rotation and scale, and is the reason pivot changes are not
 * undoable-visible: nothing about the image changes.
 */
export function repinPivot(pose: Pose, newPivotLocal: Vec2): Pose {
  const m = poseToMatrix(pose);
  return makePose({
    position: matApply(m, newPivotLocal),
    rotation: pose.rotation,
    scale: pose.scale,
    pivot: newPivotLocal,
  });
}

/** Pivot at a normalized anchor of a local box — "centre", "top-left", etc. */
export const pivotFromAnchor = (box: Rect, anchor: Vec2): Vec2 =>
  vec(box.x + box.w * anchor.x, box.y + box.h * anchor.y);

export const poseTranslate = (pose: Pose, delta: Vec2): Pose =>
  makePose({
    ...pose,
    position: vec(pose.position.x + delta.x, pose.position.y + delta.y),
  });

export const poseRotateBy = (pose: Pose, deltaDeg: number): Pose =>
  makePose({ ...pose, rotation: normalizeAngle(pose.rotation + deltaDeg) });

export const poseSetRotation = (pose: Pose, deg: number): Pose =>
  makePose({ ...pose, rotation: normalizeAngle(deg) });

export const poseScaleBy = (pose: Pose, sx: number, sy: number): Pose =>
  makePose({
    ...pose,
    scale: vec(pose.scale.x * sx, pose.scale.y * sy),
  });

/**
 * Apply an arbitrary canvas-space transform to a pose.
 *
 * The pivot is preserved in LOCAL space, so the operation composes: applying
 * A then B equals applying B·A, exactly. That property is what lets a
 * multi-selection rotate about a shared pivot without each layer drifting.
 */
export function poseApplyCanvas(pose: Pose, canvasM: Mat2D): Pose {
  const composed = matChain(canvasM, poseToMatrix(pose));
  return matrixToPose(composed, pose.pivot);
}

/** Rotate about an arbitrary canvas point — the shared-pivot case. */
export function poseRotateAbout(
  pose: Pose,
  deltaDeg: number,
  centerCanvas: Vec2
): Pose {
  const m = matChain(
    matTranslate(centerCanvas.x, centerCanvas.y),
    matRotate(deltaDeg),
    matTranslate(-centerCanvas.x, -centerCanvas.y)
  );
  return poseApplyCanvas(pose, m);
}

export function poseScaleAbout(
  pose: Pose,
  sx: number,
  sy: number,
  centerCanvas: Vec2
): Pose {
  const m = matChain(
    matTranslate(centerCanvas.x, centerCanvas.y),
    matScale(sx, sy),
    matTranslate(-centerCanvas.x, -centerCanvas.y)
  );
  return poseApplyCanvas(pose, m);
}

export const posesEqual = (a: Pose, b: Pose, tol = 1e-6): boolean =>
  Math.abs(a.position.x - b.position.x) <= tol &&
  Math.abs(a.position.y - b.position.y) <= tol &&
  Math.abs(a.scale.x - b.scale.x) <= tol &&
  Math.abs(a.scale.y - b.scale.y) <= tol &&
  Math.abs(a.pivot.x - b.pivot.x) <= tol &&
  Math.abs(a.pivot.y - b.pivot.y) <= tol &&
  Math.abs(a.rotation - b.rotation) <= tol;
