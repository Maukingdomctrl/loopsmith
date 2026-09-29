/**
 * Non-destructive cropping, at two levels.
 *
 * LAYER CROP is a rect in the layer's LOCAL space. That is the only space in
 * which a crop can be an axis-aligned rect: a canvas-space rect intersected
 * with a rotated layer is a general polygon, and storing it as a rect would
 * silently clip the wrong pixels the moment the layer is rotated.
 *
 * DOCUMENT CROP is a rect in canvas space. It clips the composite and, when
 * committed, redefines the export surface — so it translates every layer so
 * the crop's top-left becomes the new origin. Both operations are reversible
 * until pixels are explicitly flattened.
 */

import type { Rect, Vec2 } from "@/types/geometry";
import type { DocumentCrop, Layer, LayerSelection } from "@/types/layer";
import { CANVAS_SIZE } from "@/lib/frameTransform";
import { matApply, matInvert } from "@/lib/geometry/mat2d";
import {
  RECT_EMPTY,
  rect,
  rectClampTo,
  rectEquals,
  rectIntersect,
  rectIsEmpty,
  rectNormalize,
  rectOuterPixels,
  rectRight,
  rectBottom,
  rectUnionAll,
} from "@/lib/geometry/rect";
import { clamp } from "@/lib/geometry/scalar";
import { quadBounds } from "@/lib/geometry/rect";
import { HANDLE_ANCHORS, type HandleId } from "@/lib/geometry/hitTest";
import { updateLayer } from "./layerOps";
import {
  layerBoundsCanvas,
  layerContentBox,
  layerMatrix,
  layerQuadCanvas,
} from "./layerSpace";
import { translateAllLayers } from "./transformOps";
import { MIN_CROP_SIZE } from "./constants";

export const CANVAS_RECT: Rect = rect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

/* ---------------- layer crop ---------------- */

/** The full bitmap rect — the identity crop. */
export const fullCropOf = (layer: Layer): Rect =>
  rect(0, 0, Math.max(0, layer.size.w), Math.max(0, layer.size.h));

/**
 * Set a layer's crop from a LOCAL rect.
 *
 * Clamped to the bitmap and floored to whole pixels: a fractional crop cannot
 * be represented when the layer is eventually flattened, so allowing one would
 * make crop → flatten → crop a lossy round trip.
 */
export function setLayerCrop(
  layers: readonly Layer[],
  id: string,
  localRect: Rect | null
): Layer[] {
  const layer = layers.find((l) => l.id === id);
  if (!layer || layer.locked) return layers as Layer[];
  if (localRect === null) return updateLayer(layers, id, { crop: null });

  const full = fullCropOf(layer);
  const clamped = rectClampTo(rectOuterPixels(localRect), full);
  if (clamped.w < MIN_CROP_SIZE || clamped.h < MIN_CROP_SIZE) {
    return layers as Layer[];
  }
  // Storing the full rect as null keeps `isIdentityCrop` a pointer check and
  // keeps persisted documents free of redundant state.
  return updateLayer(layers, id, {
    crop: rectEquals(clamped, full) ? null : clamped,
  });
}

/** Convert a canvas-space crop rect into the primary layer's local space.
 *  Returns null when the layer matrix is singular. */
export function canvasCropToLocal(layer: Layer, canvasRect: Rect): Rect | null {
  const inv = matInvert(layerMatrix(layer));
  if (!inv) return null;
  const n = rectNormalize(canvasRect);
  const corners: Vec2[] = [
    { x: n.x, y: n.y },
    { x: rectRight(n), y: n.y },
    { x: rectRight(n), y: rectBottom(n) },
    { x: n.x, y: rectBottom(n) },
  ];
  // AABB of the transformed corners: for a rotated layer the canvas rect is
  // not axis-aligned locally, and the bounding box is the only rect that is
  // guaranteed to contain everything the user enclosed.
  return quadBounds([
    matApply(inv, corners[0]),
    matApply(inv, corners[1]),
    matApply(inv, corners[2]),
    matApply(inv, corners[3]),
  ]);
}

export function cropLayerFromCanvasRect(
  layers: readonly Layer[],
  id: string,
  canvasRect: Rect
): Layer[] {
  const layer = layers.find((l) => l.id === id);
  if (!layer) return layers as Layer[];
  const local = canvasCropToLocal(layer, canvasRect);
  return local ? setLayerCrop(layers, id, local) : (layers as Layer[]);
}

export const clearLayerCrop = (layers: readonly Layer[], id: string): Layer[] =>
  setLayerCrop(layers, id, null);

export const isIdentityCrop = (layer: Layer): boolean => layer.crop === null;

/**
 * Trim a layer's crop to its opaque content — "crop to content".
 *
 * Takes a precomputed alpha bounding box in local pixels (the caller has the
 * decoded bitmap; this module stays DOM-free).
 */
export function cropLayerToContent(
  layers: readonly Layer[],
  id: string,
  alphaBounds: Rect
): Layer[] {
  if (rectIsEmpty(alphaBounds)) return layers as Layer[];
  return setLayerCrop(layers, id, alphaBounds);
}

/* ---------------- document crop ---------------- */

export interface DocumentCropDraft {
  /** Canvas-space rect being dragged. */
  readonly rect: Rect;
  /** Locked aspect ratio (w/h), or null for free. */
  readonly aspect: number | null;
}

export const createCropDraft = (r: Rect = CANVAS_RECT): DocumentCropDraft => ({
  rect: rectClampTo(rectNormalize(r), CANVAS_RECT),
  aspect: null,
});

/**
 * Resize a crop draft by dragging one handle.
 *
 * Each handle moves only the edges it touches; the opposite edges are fixed.
 * That is what makes a crop rectangle feel correct, and it is why this is not
 * expressed as a scale about an anchor — a scale would move both edges.
 */
export function resizeCropDraft(
  draft: DocumentCropDraft,
  handle: HandleId,
  pointCanvas: Vec2,
  bounds: Rect = CANVAS_RECT
): DocumentCropDraft {
  const r = draft.rect;
  let left = r.x;
  let top = r.y;
  let right = rectRight(r);
  let bottom = rectBottom(r);

  const px = clamp(pointCanvas.x, bounds.x, rectRight(bounds));
  const py = clamp(pointCanvas.y, bounds.y, rectBottom(bounds));

  const anchor = HANDLE_ANCHORS[handle as never] as Vec2 | undefined;
  if (!anchor) return draft;

  if (anchor.x === 0) left = Math.min(px, right - MIN_CROP_SIZE);
  if (anchor.x === 1) right = Math.max(px, left + MIN_CROP_SIZE);
  if (anchor.y === 0) top = Math.min(py, bottom - MIN_CROP_SIZE);
  if (anchor.y === 1) bottom = Math.max(py, top + MIN_CROP_SIZE);

  let next = rectNormalize(rect(left, top, right - left, bottom - top));

  if (draft.aspect && draft.aspect > 0) {
    next = applyAspect(next, draft.aspect, anchor, bounds);
  }
  return { ...draft, rect: rectClampTo(next, bounds) };
}

/** Force an aspect ratio, growing/shrinking whichever axis keeps the dragged
 *  corner under the cursor. */
function applyAspect(
  r: Rect,
  aspect: number,
  anchor: Vec2,
  bounds: Rect
): Rect {
  const byWidth = rect(r.x, r.y, r.w, r.w / aspect);
  const byHeight = rect(r.x, r.y, r.h * aspect, r.h);
  // Prefer the variant that stays inside the bounds; if both do, prefer the
  // one closer to the user's dragged size so the rect does not jump.
  const fits = (c: Rect) =>
    c.w <= bounds.w && c.h <= bounds.h;
  const chosen =
    fits(byWidth) && (!fits(byHeight) || Math.abs(byWidth.h - r.h) <= Math.abs(byHeight.w - r.w))
      ? byWidth
      : byHeight;

  // Keep the anchored edges pinned.
  const x = anchor.x === 1 ? r.x : rectRight(r) - chosen.w;
  const y = anchor.y === 1 ? r.y : rectBottom(r) - chosen.h;
  return rectNormalize(rect(anchor.x === 0.5 ? r.x : x, anchor.y === 0.5 ? r.y : y, chosen.w, chosen.h));
}

export function moveCropDraft(
  draft: DocumentCropDraft,
  deltaCanvas: Vec2,
  bounds: Rect = CANVAS_RECT
): DocumentCropDraft {
  const moved = rect(
    draft.rect.x + deltaCanvas.x,
    draft.rect.y + deltaCanvas.y,
    draft.rect.w,
    draft.rect.h
  );
  return { ...draft, rect: rectClampTo(moved, bounds) };
}

/** A preview crop only clips; nothing moves and nothing is lost. */
export const previewDocumentCrop = (draft: DocumentCropDraft): DocumentCrop => ({
  rect: rectNormalize(draft.rect),
  committed: false,
});

export interface CommitCropResult {
  readonly layers: Layer[];
  readonly crop: DocumentCrop;
  /** New document size. Callers that keep a fixed 512 surface re-fit instead. */
  readonly size: { w: number; h: number };
}

/**
 * Commit a document crop.
 *
 * Every layer is translated by −(crop origin) so the crop's top-left becomes
 * the new document origin. A uniform translation of all layers is the ONLY
 * operation here: it is exactly invertible, preserves every layer's relative
 * arrangement, rotation and scale, and leaves all pixels untouched.
 *
 * Because this editor's surface is a fixed square, the result is then re-fitted
 * by the caller via `refitAfterCrop`, which is a single further uniform
 * scale — again lossless at the geometry level.
 */
export function commitDocumentCrop(
  layers: readonly Layer[],
  draft: DocumentCropDraft
): CommitCropResult {
  const r = rectOuterPixels(rectClampTo(rectNormalize(draft.rect), CANVAS_RECT));
  return {
    layers: translateAllLayers(layers, { x: -r.x, y: -r.y }),
    crop: { rect: rect(0, 0, r.w, r.h), committed: true },
    size: { w: r.w, h: r.h },
  };
}

/**
 * Re-fit a committed crop back onto the fixed square surface.
 *
 * Scales every layer about the origin by the contain factor and centres the
 * result. Expressed as one canvas-space matrix applied to all layers, so it
 * composes with whatever transforms each layer already had.
 */
export function refitAfterCrop(
  layers: readonly Layer[],
  size: { w: number; h: number },
  surface: number = CANVAS_SIZE
): Layer[] {
  const s = Math.min(surface / Math.max(1, size.w), surface / Math.max(1, size.h));
  const offX = (surface - size.w * s) / 2;
  const offY = (surface - size.h * s) / 2;

  return layers.map((l) => ({
    ...l,
    pose: {
      ...l.pose,
      position: {
        x: l.pose.position.x * s + offX,
        y: l.pose.position.y * s + offY,
      },
      scale: { x: l.pose.scale.x * s, y: l.pose.scale.y * s },
    },
  }));
}

/** Cancel: nothing was mutated, so this is a pure state discard. */
export const cancelDocumentCrop = (): DocumentCrop | null => null;

/* ---------------- derived ---------------- */

/** Tight canvas-space bounds of everything renderable — "crop to artwork". */
export function contentBoundsCanvas(layers: readonly Layer[]): Rect {
  const rects = layers
    .filter((l) => l.visible && (l.image || l.strokes?.length))
    .map(layerBoundsCanvas);
  return rects.length ? rectIntersect(rectUnionAll(rects), CANVAS_RECT) : RECT_EMPTY;
}

/** Is any part of this layer inside the current crop? Used to grey out
 *  layer-panel rows for content the export will not contain. */
export function layerIntersectsCrop(layer: Layer, crop: DocumentCrop | null): boolean {
  const region = crop?.rect ?? CANVAS_RECT;
  return !rectIsEmpty(rectIntersect(layerBoundsCanvas(layer), region));
}
