/**
 * The layer editor, as one pure reducer over a Frame.
 *
 * WHY A REDUCER: `page.tsx` owns undo (pushUndo snapshots the whole Project
 * and captures activeFrame). If the layer UI called setProjects directly it
 * would duplicate that logic and drift from it — which is exactly how the
 * existing selection/lasso code ended up with two separate history paths. So
 * every layer mutation is an action, every action is a pure Frame → Frame, and
 * `page.tsx` decides whether it opens a new undo step.
 *
 * `undoable` is part of the action contract, not a caller decision: a pivot
 * repin or a visibility toggle should coalesce, a delete should not, and only
 * the reducer knows which is which.
 */

import type { Rect, Vec2 } from "@/types/geometry";
import type { Frame } from "@/types/frame";
import type { BlendMode, Layer, LayerSelection } from "@/types/layer";
import { EMPTY_SELECTION } from "@/types/layer";
import { clearTransforms } from "@/lib/frameTransform";
import {
  addLayer,
  createLayer,
  duplicateLayer,
  findLayer,
  layerToBack,
  layerToFront,
  lowerLayer,
  moveLayer,
  raiseLayer,
  removeLayer,
  renameLayer,
  setLayerLocked,
  setLayerOpacity,
  setLayerVisible,
  updateLayer,
} from "./layerOps";
import {
  centerSelection,
  fitLayerToCanvas,
  flipLayer,
  moveSelection,
  nudgeSelection,
  resetLayerTransform,
  rotateSelectionBy,
  scaleSelectionBy,
  setLayerPivotAnchor,
  setLayerPivotCanvas,
  setLayerPosition,
  setLayerRotation,
  setLayerScale,
  setLayerZoom,
  straightenSelection,
  straightenToNearestRightAngle,
  updateRotate,
  updateScale,
  type RotateGesture,
  type ScaleGesture,
} from "./transformOps";
import {
  clearLayerCrop,
  commitDocumentCrop,
  cropLayerFromCanvasRect,
  cropLayerToContent,
  refitAfterCrop,
  setLayerCrop,
  type DocumentCropDraft,
} from "./crop";
import { attachLayerSize, syncBaseFromLegacy } from "./migrate";
import { defaultFitPose } from "./layerSpace";
import { pruneSelection, selectOnly } from "./selection";

export type LayerAction =
  /* structure */
  | { type: "layer/add"; image: string | null; size: { w: number; h: number }; name?: string }
  | { type: "layer/duplicate"; id: string }
  | { type: "layer/remove"; id: string }
  | { type: "layer/move"; id: string; to: number }
  | { type: "layer/raise"; id: string }
  | { type: "layer/lower"; id: string }
  | { type: "layer/front"; id: string }
  | { type: "layer/back"; id: string }
  /* properties */
  | { type: "layer/rename"; id: string; name: string }
  | { type: "layer/visible"; id: string; value: boolean }
  | { type: "layer/locked"; id: string; value: boolean }
  | { type: "layer/opacity"; id: string; value: number }
  | { type: "layer/blend"; id: string; value: BlendMode }
  | { type: "layer/alphaLock"; id: string; value: boolean }
  | { type: "layer/setImage"; id: string; image: string; size: { w: number; h: number } }
  | { type: "layer/sizeKnown"; id: string; width: number; height: number }
  | { type: "layer/setActive"; id: string }
  /* transform */
  | { type: "xf/move"; selection: LayerSelection; delta: Vec2 }
  | { type: "xf/nudge"; selection: LayerSelection; dx: number; dy: number }
  | { type: "xf/position"; id: string; position: Vec2 }
  | { type: "xf/rotateBy"; selection: LayerSelection; delta: number }
  | { type: "xf/rotateTo"; id: string; deg: number }
  | { type: "xf/rotateDrag"; selection: LayerSelection; gesture: RotateGesture; pointer: Vec2; snap: boolean }
  | { type: "xf/scaleBy"; selection: LayerSelection; sx: number; sy: number; center?: Vec2 }
  | { type: "xf/scaleTo"; id: string; scale: Vec2 }
  | { type: "xf/zoomTo"; id: string; zoom: number; baseScale: number }
  | { type: "xf/scaleDrag"; gesture: ScaleGesture; pointer: Vec2; uniform: boolean; fromCenter: boolean }
  | { type: "xf/straighten"; selection: LayerSelection; a: Vec2; b: Vec2; axis: "horizontal" | "vertical" }
  | { type: "xf/straightenRight"; selection: LayerSelection }
  | { type: "xf/center"; selection: LayerSelection }
  | { type: "xf/fit"; id: string }
  | { type: "xf/flip"; id: string; axis: "x" | "y" }
  | { type: "xf/pivotCanvas"; id: string; point: Vec2 }
  | { type: "xf/pivotAnchor"; id: string; anchor: Vec2 }
  | { type: "xf/reset"; id: string }
  /* crop */
  | { type: "crop/layer"; id: string; canvasRect: Rect }
  | { type: "crop/layerLocal"; id: string; localRect: Rect | null }
  | { type: "crop/layerToContent"; id: string; alphaBounds: Rect }
  | { type: "crop/clearLayer"; id: string }
  | { type: "crop/commitDocument"; draft: DocumentCropDraft; refit: boolean }
  | { type: "crop/clearDocument" };

/** Actions that must NOT open a new undo step, because they either change no
 *  pixels or are continuations of a gesture whose first event already did. */
const TRANSIENT = new Set<LayerAction["type"]>([
  "layer/setActive",
  "layer/sizeKnown",
  "xf/rotateDrag",
  "xf/scaleDrag",
  "xf/move",
]);

export const isUndoable = (action: LayerAction): boolean =>
  !TRANSIENT.has(action.type);

/**
 * Apply an action to a frame.
 *
 * Returns the SAME frame object when nothing changed, so React bails out and
 * `page.tsx` can cheaply detect a no-op and skip the undo push entirely.
 */
export function layerReducer(frame: Frame, action: LayerAction): Frame {
  const layers = frame.layers;
  let next: Layer[] = layers as Layer[];
  let activeLayerId = frame.activeLayerId;
  let crop = frame.crop;

  switch (action.type) {
    /* ---- structure ---- */
    case "layer/add": {
      const layer = createLayer({
        image: action.image,
        size: action.size,
        name: action.name ?? `Layer ${layers.length}`,
        pose: defaultFitPose(action.size.w, action.size.h),
      });
      next = addLayer(layers, layer, frame.activeLayerId);
      activeLayerId = layer.id;
      break;
    }
    case "layer/duplicate": {
      const r = duplicateLayer(layers, action.id);
      next = r.layers;
      if (r.newId) activeLayerId = r.newId;
      break;
    }
    case "layer/remove": {
      const r = removeLayer(layers, action.id);
      next = r.layers;
      activeLayerId = r.nextSelectedId;
      break;
    }
    case "layer/move":  next = moveLayer(layers, action.id, action.to); break;
    case "layer/raise": next = raiseLayer(layers, action.id); break;
    case "layer/lower": next = lowerLayer(layers, action.id); break;
    case "layer/front": next = layerToFront(layers, action.id); break;
    case "layer/back":  next = layerToBack(layers, action.id); break;

    /* ---- properties ---- */
    case "layer/rename":  next = renameLayer(layers, action.id, action.name); break;
    case "layer/visible": next = setLayerVisible(layers, action.id, action.value); break;
    case "layer/locked":  next = setLayerLocked(layers, action.id, action.value); break;
    case "layer/opacity": next = setLayerOpacity(layers, action.id, action.value); break;
    case "layer/blend":   next = updateLayer(layers, action.id, { blend: action.value }); break;
    case "layer/alphaLock": next = updateLayer(layers, action.id, { alphaLock: action.value }); break;

    case "layer/setImage": {
  const existing = findLayer(layers, action.id);

  const sameSize =
    !!existing?.image &&
    existing.size.w === action.size.w &&
    existing.size.h === action.size.h;

  const updatedLayers = updateLayer(layers, action.id, {
    image: action.image,
    size: action.size,
    crop: null,
    pose: sameSize
      ? existing!.pose
      : defaultFitPose(action.size.w, action.size.h),
  });

  return finalize(
    clearTransforms({
      ...frame,
      layers: updatedLayers,
      legacyPosePending: false,
    }),
    frame
  );
}
    case "layer/sizeKnown":
      return finalize(
        attachLayerSize(frame, action.id, action.width, action.height),
        frame
      );

    case "layer/setActive":
      activeLayerId = findLayer(layers, action.id) ? action.id : frame.activeLayerId;
      break;

    /* ---- transform ---- */
    case "xf/move":      next = moveSelection(layers, action.selection, action.delta); break;
    case "xf/nudge":     next = nudgeSelection(layers, action.selection, action.dx, action.dy); break;
    case "xf/position":  next = setLayerPosition(layers, action.id, action.position); break;
    case "xf/rotateBy":  next = rotateSelectionBy(layers, action.selection, action.delta); break;
    case "xf/rotateTo":  next = setLayerRotation(layers, action.id, action.deg); break;
    case "xf/rotateDrag":
      next = updateRotate(layers, action.selection, action.gesture, action.pointer, action.snap);
      break;
    case "xf/scaleBy":
      next = scaleSelectionBy(layers, action.selection, action.sx, action.sy, action.center);
      break;
    case "xf/scaleTo": next = setLayerScale(layers, action.id, action.scale); break;
    case "xf/zoomTo":  next = setLayerZoom(layers, action.id, action.zoom, action.baseScale); break;
    case "xf/scaleDrag":
      next = updateScale(layers, action.gesture, action.pointer, {
        uniform: action.uniform,
        fromCenter: action.fromCenter,
      });
      break;
    case "xf/straighten":
      next = straightenSelection(layers, action.selection, action.a, action.b, action.axis);
      break;
    case "xf/straightenRight":
      next = straightenToNearestRightAngle(layers, action.selection);
      break;
    case "xf/center":      next = centerSelection(layers, action.selection); break;
    case "xf/fit":         next = fitLayerToCanvas(layers, action.id); break;
    case "xf/flip":        next = flipLayer(layers, action.id, action.axis); break;
    case "xf/pivotCanvas": next = setLayerPivotCanvas(layers, action.id, action.point); break;
    case "xf/pivotAnchor": next = setLayerPivotAnchor(layers, action.id, action.anchor); break;
    case "xf/reset":       next = resetLayerTransform(layers, action.id); break;

    /* ---- crop ---- */
    case "crop/layer":
      next = cropLayerFromCanvasRect(layers, action.id, action.canvasRect);
      break;
    case "crop/layerLocal":
      next = setLayerCrop(layers, action.id, action.localRect);
      break;
    case "crop/layerToContent":
      next = cropLayerToContent(layers, action.id, action.alphaBounds);
      break;
    case "crop/clearLayer":
      next = clearLayerCrop(layers, action.id);
      break;
    case "crop/commitDocument": {
      const r = commitDocumentCrop(layers, action.draft);
      next = action.refit ? refitAfterCrop(r.layers, r.size) : r.layers;
      // After a refit the document is square again, so the crop clip is no
      // longer needed — keeping it would clip a second time on every render.
      crop = action.refit ? null : r.crop;
      break;
    }
    case "crop/clearDocument":
      crop = null;
      break;
  }

  if (next === layers && activeLayerId === frame.activeLayerId && crop === frame.crop) {
    return frame;
  }
  return finalize({ ...frame, layers: next, activeLayerId, crop }, frame);
}

/**
 * Post-mutation invariants, applied to EVERY action exactly once:
 *  1. legacy x/y/zoom/rotation re-derived from the base layer;
 *  2. the flatten cache invalidated so `frame.image` recomposites.
 *
 * Doing this here rather than in each case is what keeps the compatibility
 * contract from depending on forty individual call sites remembering it.
 */
function finalize(updated: Frame, original: Frame): Frame {
  if (updated === original) return original;
  const synced = syncBaseFromLegacy(updated);
  return { ...synced, flattenKey: null };
}

/** Selection is editor state, so it reduces separately and is never persisted. */
export function reduceSelectionForFrame(
  frame: Frame,
  selection: LayerSelection
): LayerSelection {
  const pruned = pruneSelection(frame.layers, selection);
  if (pruned.ids.length > 0) return pruned;
  return frame.activeLayerId ? selectOnly(frame.activeLayerId) : EMPTY_SELECTION;
}
