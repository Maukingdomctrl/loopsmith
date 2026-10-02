/**
 * The transform tools, as pure functions over layers.
 *
 * All of them share one shape: take the layers, the selection, and a
 * canvas-space gesture; return new layers. No DOM, no React, no pointer
 * events — so each tool is directly testable, and the on-canvas overlay and
 * the numeric panel drive the SAME code rather than two implementations that
 * disagree at the third decimal place.
 */

import type { Mat2D, Rect, Vec2 } from "@/types/geometry";
import type { Layer, LayerSelection } from "@/types/layer";
import { isLockedIn } from "@/types/layer";
import {
  angleBetweenPoints,
  angleDelta,
  magneticSnapAngle,
  normalizeAngle,
  straightenDeltaHorizontal,
  straightenDeltaVertical,
} from "@/lib/geometry/angle";
import {
  clampScale,
  matChain,
  matRotate,
  matScale,
  matTranslate,
} from "@/lib/geometry/mat2d";

import { matApply, matInvert } from "@/lib/geometry/mat2d";

import {
  IDENTITY_POSE,
  makePose,
  pivotFromAnchor,
  poseApplyCanvas,
  poseRotateAbout,
  poseScaleAbout,
  poseTranslate,
  posesEqual,
  repinPivot,
  type Pose,
} from "@/lib/geometry/pose";
import { containScale, rectCenter, rectIsEmpty } from "@/lib/geometry/rect";
import { clamp } from "@/lib/geometry/scalar";
import { vSub } from "@/lib/geometry/vec2";
import { HANDLE_ANCHORS, OPPOSITE_HANDLE, type HandleId } from "@/lib/geometry/hitTest";
import { CANVAS_SIZE } from "@/lib/frameTransform";
import { updateLayer } from "./layerOps";
import {
  defaultFitPose,
  layerContentBox,
  layerLocalToCanvas,
  layerMatrix,
} from "./layerSpace";
import {
  selectionBounds,
  selectionPivotCanvas,
  transformableLayers,
} from "./selection";
import { MIN_CROP_SIZE, ROTATE_SNAP_STEP, ROTATE_SNAP_TOLERANCE } from "./constants";

/** Apply a pose patch to every transformable selected layer. Untouched layers
 *  keep referential identity so the layer panel does not re-render wholesale. */
function mapSelected(
  layers: readonly Layer[],
  sel: LayerSelection,
  fn: (layer: Layer) => Pose
): Layer[] {
  const ids = new Set(transformableLayers(layers, sel).map((l) => l.id));
  if (ids.size === 0) return layers as Layer[];

  let changed = false;
  const next = layers.map((l) => {
    if (!ids.has(l.id)) return l;
    const pose = fn(l);
    if (posesEqual(pose, l.pose, 0)) return l;
    changed = true;
    return { ...l, pose };
  });
  return changed ? next : (layers as Layer[]);
}

/* ---------------- move ---------------- */

export const moveSelection = (
  layers: readonly Layer[],
  sel: LayerSelection,
  deltaCanvas: Vec2
): Layer[] => mapSelected(layers, sel, (l) => poseTranslate(l.pose, deltaCanvas));

/** Absolute placement of the primary layer's pivot. Drives the X/Y fields. */
export function setLayerPosition(
  layers: readonly Layer[],
  id: string,
  position: Vec2
): Layer[] {
  const layer = layers.find((l) => l.id === id);
  if (!layer || isLockedIn(layers, layer)) return layers as Layer[];
  return updateLayer(layers, id, {
    pose: makePose({ ...layer.pose, position }),
  });
}

export const nudgeSelection = (
  layers: readonly Layer[],
  sel: LayerSelection,
  dx: number,
  dy: number
): Layer[] => moveSelection(layers, sel, { x: dx, y: dy });

/** Centre the selection on the canvas as a rigid group, preserving each
 *  layer's relative offset — not by setting every position to the centre. */
export function centerSelection(
  layers: readonly Layer[],
  sel: LayerSelection
): Layer[] {
  const b = selectionBounds(layers, sel);
  if (rectIsEmpty(b)) return layers as Layer[];
  const c = rectCenter(b);
  return moveSelection(layers, sel, {
    x: CANVAS_SIZE / 2 - c.x,
    y: CANVAS_SIZE / 2 - c.y,
  });
}

/* ---------------- rotate ---------------- */

export const rotateSelectionBy = (
  layers: readonly Layer[],
  sel: LayerSelection,
  deltaDeg: number
): Layer[] => {
  const pivot = selectionPivotCanvas(layers, sel);
  if (!pivot) return layers as Layer[];
  const items = transformableLayers(layers, sel);
  // Single selection rotates about its OWN pivot, which is already `position`,
  // so the cheaper pure-angle path is exact there.
  if (items.length === 1) {
    return mapSelected(layers, sel, (l) =>
      makePose({ ...l.pose, rotation: normalizeAngle(l.pose.rotation + deltaDeg) })
    );
  }
  return mapSelected(layers, sel, (l) => poseRotateAbout(l.pose, deltaDeg, pivot));
};

/** Absolute angle, 0–360. The rotation field and the dial both call this. */
export function setLayerRotation(
  layers: readonly Layer[],
  id: string,
  deg: number
): Layer[] {
  const layer = layers.find((l) => l.id === id);
  if (!layer || isLockedIn(layers, layer)) return layers as Layer[];
  return updateLayer(layers, id, {
    pose: makePose({ ...layer.pose, rotation: normalizeAngle(deg) }),
  });
}

export interface RotateGesture {
  /** Angle from the pivot to the pointer when the drag started. */
  readonly startAngle: number;
  readonly startRotation: number;
  readonly pivotCanvas: Vec2;
}

export function beginRotate(
  layers: readonly Layer[],
  sel: LayerSelection,
  pointerCanvas: Vec2
): RotateGesture | null {
  const pivot = selectionPivotCanvas(layers, sel);
  const primary = layers.find((l) => l.id === sel.primary);
  if (!pivot || !primary) return null;
  return {
    startAngle: angleBetweenPoints(pivot, pointerCanvas),
    startRotation: primary.pose.rotation,
    pivotCanvas: pivot,
  };
}

/**
 * Continue a rotation drag.
 *
 * The delta is computed in (-180, 180] against the gesture's START angle, so
 * dragging across the 0/360 seam never spins the layer the long way — the bug
 * that makes rotation feel broken in most naive implementations.
 */
export function updateRotate(
  layers: readonly Layer[],
  sel: LayerSelection,
  gesture: RotateGesture,
  pointerCanvas: Vec2,
  snap: boolean
): Layer[] {
  const now = angleBetweenPoints(gesture.pivotCanvas, pointerCanvas);
  const raw = angleDelta(gesture.startAngle, now);
  const target = snap
    ? magneticSnapAngle(
        gesture.startRotation + raw,
        ROTATE_SNAP_STEP,
        ROTATE_SNAP_TOLERANCE
      )
    : normalizeAngle(gesture.startRotation + raw);

  const applied = angleDelta(gesture.startRotation, target);
  return rotateSelectionBy(layers, sel, applied);
}

/* ---------------- straighten ---------------- */

/** Rotate so the line the user drew becomes horizontal (or vertical). The
 *  delta is folded into (-90, 90], so straightening never flips the art. */
export function straightenSelection(
  layers: readonly Layer[],
  sel: LayerSelection,
  a: Vec2,
  b: Vec2,
  axis: "horizontal" | "vertical" = "horizontal"
): Layer[] {
  const delta =
    axis === "horizontal"
      ? straightenDeltaHorizontal(a, b)
      : straightenDeltaVertical(a, b);
  return delta === 0 ? (layers as Layer[]) : rotateSelectionBy(layers, sel, delta);
}

/** Snap the primary layer's rotation to the nearest right angle — the
 *  "auto-straighten" button. */
export function straightenToNearestRightAngle(
  layers: readonly Layer[],
  sel: LayerSelection
): Layer[] {
  const primary = layers.find((l) => l.id === sel.primary);
  if (!primary) return layers as Layer[];
  const target = Math.round(primary.pose.rotation / 90) * 90;
  return rotateSelectionBy(layers, sel, angleDelta(primary.pose.rotation, target));
}

/* ---------------- scale ---------------- */

export const scaleSelectionBy = (
  layers: readonly Layer[],
  sel: LayerSelection,
  sx: number,
  sy: number,
  centerCanvas?: Vec2
): Layer[] => {
  const center =
    centerCanvas ?? selectionPivotCanvas(layers, sel) ?? {
      x: CANVAS_SIZE / 2,
      y: CANVAS_SIZE / 2,
    };
  return mapSelected(layers, sel, (l) => poseScaleAbout(l.pose, sx, sy, center));
};

export function setLayerScale(
  layers: readonly Layer[],
  id: string,
  scale: Vec2
): Layer[] {
  const layer = layers.find((l) => l.id === id);
  if (!layer || isLockedIn(layers, layer)) return layers as Layer[];
  return updateLayer(layers, id, {
    pose: makePose({ ...layer.pose, scale: clampScale(scale) }),
  });
}

/** Uniform zoom about the layer's own pivot — what the zoom slider drives. */
export function setLayerZoom(
  layers: readonly Layer[],
  id: string,
  zoom: number,
  baseScale: number
): Layer[] {
  const s = baseScale * zoom;
  return setLayerScale(layers, id, { x: s, y: s });
}

export interface ScaleGesture {
  readonly handle: HandleId;
  /** Fixed point of the drag, in canvas space: the opposite handle. */
  readonly anchorCanvas: Vec2;
  readonly startPose: Pose;
  readonly startBox: Rect;
  readonly startPointer: Vec2;
  readonly layerId: string;
}

export function beginScale(
  layers: readonly Layer[],
  sel: LayerSelection,
  handle: HandleId,
  pointerCanvas: Vec2
): ScaleGesture | null {
  const layer = layers.find((l) => l.id === sel.primary);
  if (!layer || isLockedIn(layers, layer)) return null;
  const opposite = OPPOSITE_HANDLE[handle];
  if (!opposite) return null;

  const box = layerContentBox(layer);
  const anchorLocal = pivotFromAnchor(box, HANDLE_ANCHORS[opposite as never]);
  return {
    handle,
    anchorCanvas: layerLocalToCanvas(layer, anchorLocal),
    startPose: layer.pose,
    startBox: box,
    startPointer: pointerCanvas,
    layerId: layer.id,
  };
}

/**
 * Continue a scale drag.
 *
 * The pointer offset is measured in the layer's own ROTATED frame, so dragging
 * the east handle of a 30°-rotated layer widens it along its own x axis rather
 * than along the screen's. Achieved by rotating the canvas-space offset by
 * −rotation before dividing, which is exact and needs no inverse matrix.
 */
export function updateScale(
  layers: readonly Layer[],
  gesture: ScaleGesture,
  pointerCanvas: Vec2,
  opts: { uniform: boolean; fromCenter: boolean }
): Layer[] {
  const layer = layers.find((l) => l.id === gesture.layerId);
  if (!layer) return layers as Layer[];

  const anchor = opts.fromCenter
    ? layerLocalToCanvas(layer, pivotFromAnchor(gesture.startBox, { x: 0.5, y: 0.5 }))
    : gesture.anchorCanvas;

  const rot = -gesture.startPose.rotation;
  const toLocalAxis = (v: Vec2): Vec2 => {
    const r = (rot * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    return { x: v.x * cos - v.y * sin, y: v.x * sin + v.y * cos };
  };

  const startVec = toLocalAxis(vSub(gesture.startPointer, anchor));
  const nowVec = toLocalAxis(vSub(pointerCanvas, anchor));

  const anchorAnchor = HANDLE_ANCHORS[
    (OPPOSITE_HANDLE[gesture.handle] as never)
  ] as Vec2;
  const movesX = anchorAnchor.x !== 0.5;
  const movesY = anchorAnchor.y !== 0.5;

  // A zero start offset would divide by zero; fall back to no change on that
  // axis rather than producing Infinity and destroying the pose.
  let sx = movesX && Math.abs(startVec.x) > 1e-6 ? nowVec.x / startVec.x : 1;
  let sy = movesY && Math.abs(startVec.y) > 1e-6 ? nowVec.y / startVec.y : 1;

  if (opts.uniform) {
    const m = movesX && movesY ? Math.max(Math.abs(sx), Math.abs(sy)) : movesX ? Math.abs(sx) : Math.abs(sy);
    sx = movesX ? Math.sign(sx || 1) * m : m;
    sy = movesY ? Math.sign(sy || 1) * m : m;
  }

  const scale = clampScale({
    x: gesture.startPose.scale.x * sx,
    y: gesture.startPose.scale.y * sy,
  });

  // Rebuild from the gesture's START pose, never from the previous frame of
  // the drag: incremental application accumulates rounding and makes a drag
  // that returns to its origin fail to restore the original size.
  const rebuilt = makePose({ ...gesture.startPose, scale });
  const anchorLocal = pivotFromAnchor(
    gesture.startBox,
    opts.fromCenter ? { x: 0.5, y: 0.5 } : (anchorAnchor as Vec2)
  );
  const drift = vSub(anchor, layerLocalToCanvas({ ...layer, pose: rebuilt }, anchorLocal));

  return updateLayer(layers, layer.id, { pose: poseTranslate(rebuilt, drift) });
}

/** Fit the primary layer to the canvas under a contain fit, centred. */
export function fitLayerToCanvas(
  layers: readonly Layer[],
  id: string
): Layer[] {
  const layer = layers.find((l) => l.id === id);
  if (!layer || isLockedIn(layers, layer)) return layers as Layer[];
  const box = layerContentBox(layer);
  if (rectIsEmpty(box)) return layers as Layer[];
  const s = containScale(box.w, box.h, CANVAS_SIZE, CANVAS_SIZE);
  return updateLayer(layers, id, {
    pose: makePose({
      position: { x: CANVAS_SIZE / 2, y: CANVAS_SIZE / 2 },
      rotation: 0,
      scale: { x: s, y: s },
      pivot: pivotFromAnchor(box, { x: 0.5, y: 0.5 }),
    }),
  });
}

export const flipLayer = (
  layers: readonly Layer[],
  id: string,
  axis: "x" | "y"
): Layer[] => {
  const layer = layers.find((l) => l.id === id);
  if (!layer || isLockedIn(layers, layer)) return layers as Layer[];
  return updateLayer(layers, id, {
    pose: makePose({
      ...layer.pose,
      scale:
        axis === "x"
          ? { x: -layer.pose.scale.x, y: layer.pose.scale.y }
          : { x: layer.pose.scale.x, y: -layer.pose.scale.y },
    }),
  });
};

/* ---------------- pivot ---------------- */
/** Drag the pivot marker. Repinning never moves the artwork. */
export function setLayerPivotCanvas(
  layers: readonly Layer[],
  id: string,
  pointCanvas: Vec2
): Layer[] {
  const layer = layers.find((l) => l.id === id);
  if (!layer || isLockedIn(layers, layer)) return layers as Layer[];

  const inv = layerMatrix(layer);
  const i = matInvert(inv);
  const local = i ? matApply(i, pointCanvas) : null;

  if (!local) return layers as Layer[];

  return updateLayer(layers, id, {
    pose: repinPivot(layer.pose, local),
  });
}

export function setLayerPivotAnchor(
  layers: readonly Layer[],
  id: string,
  anchor: Vec2
): Layer[] {
  const layer = layers.find((l) => l.id === id);
  if (!layer || isLockedIn(layers, layer)) return layers as Layer[];
  const local = pivotFromAnchor(layerContentBox(layer), anchor);
  return updateLayer(layers, id, { pose: repinPivot(layer.pose, local) });
}

/* ---------------- reset ---------------- */

export function resetLayerTransform(
  layers: readonly Layer[],
  id: string
): Layer[] {
  const layer = layers.find((l) => l.id === id);
  if (!layer || isLockedIn(layers, layer)) return layers as Layer[];
  const pose = layer.size.w > 0 && layer.size.h > 0
    ? makePose(defaultFitPose(layer.size.w, layer.size.h))
    : IDENTITY_POSE;
  return updateLayer(layers, id, { pose });
}

/** Arbitrary canvas-space matrix applied to the whole selection — used by the
 *  document crop, which must move every layer by the same translation. */
export const applyMatrixToSelection = (
  layers: readonly Layer[],
  sel: LayerSelection,
  m: Mat2D
): Layer[] => mapSelected(layers, sel, (l) => poseApplyCanvas(l.pose, m));

export const translateAllLayers = (
  layers: readonly Layer[],
  delta: Vec2
): Layer[] =>
  layers.map((l) => ({ ...l, pose: poseTranslate(l.pose, delta) }));
