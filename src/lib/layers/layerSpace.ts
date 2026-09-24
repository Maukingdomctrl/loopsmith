/**
 * Coordinate-space conversion — the single seam between screen, canvas and
 * layer-local coordinates.
 *
 *   SCREEN  : CSS pixels inside the canvas container element
 *   CANVAS   : the fixed 512×512 document space (CANVAS_SIZE)
 *   VIEW     : canvas space after the non-destructive view pan/rotate
 *   LOCAL    : one layer's source-bitmap pixels
 *
 * Every conversion is a Mat2D built here, and every consumer (hit-testing,
 * overlays, compositor, crop) uses the same matrices. Nothing multiplies out
 * a transform by hand; that is how the old Canvas ended up with `frame.x/y`
 * meaning "screen pixels applied before the scale", a rule that had to be
 * remembered rather than expressed.
 */

import type { Mat2D, Rect, Vec2 } from "@/types/geometry";
import type { Layer } from "@/types/layer";
import { CANVAS_SIZE } from "@/lib/frameTransform";
import {
  MAT_IDENTITY,
  matApply,
  matChain,
  matInvert,
  matRotate,
  matScale,
  matTranslate,
} from "@/lib/geometry/mat2d";
import { poseToMatrix } from "@/lib/geometry/pose";
import { containScale, rect, rectTransformBounds, rectTransformToQuad } from "@/lib/geometry/rect";

export interface ViewState {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
}

export const IDENTITY_VIEW: ViewState = { x: 0, y: 0, rotation: 0 };

/* ---------------- screen ⇄ canvas ---------------- */

/**
 * Screen→canvas, given the container's on-screen rect.
 *
 * The container is always square and always displays the full 512 document,
 * so this is a uniform scale plus the element origin. Derived from the live
 * rect rather than a constant because the layout is responsive and a stale
 * scale shows up as a cursor that drifts from the handle it is dragging.
 */
export function screenToCanvasMatrix(bounds: DOMRect | null): Mat2D {
  if (!bounds || !bounds.width || !bounds.height) return MAT_IDENTITY;
  return matChain(
    matScale(CANVAS_SIZE / bounds.width, CANVAS_SIZE / bounds.height),
    matTranslate(-bounds.left, -bounds.top)
  );
}

export const canvasToScreenMatrix = (bounds: DOMRect | null): Mat2D =>
  matInvert(screenToCanvasMatrix(bounds)) ?? MAT_IDENTITY;

/** View transform: rotate about the canvas centre, then pan. Matches the CSS
 *  `translate(...) rotate(...)` with `transformOrigin: 256px 256px` that
 *  Canvas.tsx applies to the layer stack, so pointer maths and paint agree. */
export function viewMatrix(view: ViewState): Mat2D {
  const c = CANVAS_SIZE / 2;
  return matChain(
    matTranslate(view.x, view.y),
    matTranslate(c, c),
    matRotate(view.rotation),
    matTranslate(-c, -c)
  );
}

export const viewMatrixInverse = (view: ViewState): Mat2D =>
  matInvert(viewMatrix(view)) ?? MAT_IDENTITY;

/** Full screen→document conversion, view included. This is the function every
 *  pointer handler should call — exactly once, at the top. */
export function screenToCanvas(
  p: Vec2,
  bounds: DOMRect | null,
  view: ViewState = IDENTITY_VIEW
): Vec2 {
  const toCanvas = matApply(screenToCanvasMatrix(bounds), p);
  return matApply(viewMatrixInverse(view), toCanvas);
}

export function canvasToScreen(
  p: Vec2,
  bounds: DOMRect | null,
  view: ViewState = IDENTITY_VIEW
): Vec2 {
  const viewed = matApply(viewMatrix(view), p);
  return matApply(canvasToScreenMatrix(bounds), viewed);
}

/** Convert a screen-space DELTA (a drag) into canvas units. Uses the vector
 *  form so the element origin is not added twice. */
export function screenDeltaToCanvas(
  delta: Vec2,
  bounds: DOMRect | null,
  view: ViewState = IDENTITY_VIEW
): Vec2 {
  const a = screenToCanvas({ x: 0, y: 0 }, bounds, view);
  const b = screenToCanvas(delta, bounds, view);
  return { x: b.x - a.x, y: b.y - a.y };
}

/* ---------------- layer ⇄ canvas ---------------- */

export const layerMatrix = (layer: Layer): Mat2D => poseToMatrix(layer.pose);

export const layerMatrixInverse = (layer: Layer): Mat2D | null =>
  matInvert(layerMatrix(layer));

/** The layer's own local rect: its crop if set, otherwise its full bitmap. */
export function layerContentBox(layer: Layer): Rect {
  if (layer.crop) return layer.crop;
  return rect(0, 0, Math.max(0, layer.size.w), Math.max(0, layer.size.h));
}

export const layerBoundsCanvas = (layer: Layer): Rect =>
  rectTransformBounds(layerMatrix(layer), layerContentBox(layer));

export const layerQuadCanvas = (layer: Layer) =>
  rectTransformToQuad(layerMatrix(layer), layerContentBox(layer));

export const layerLocalToCanvas = (layer: Layer, p: Vec2): Vec2 =>
  matApply(layerMatrix(layer), p);

export function layerCanvasToLocal(layer: Layer, p: Vec2): Vec2 | null {
  const inv = layerMatrixInverse(layer);
  return inv ? matApply(inv, p) : null;
}

/**
 * The pose that makes a w×h bitmap fill the canvas under a "contain" fit,
 * centred, with its pivot at its own centre.
 *
 * This is the pose every imported bitmap starts from, and it is exactly the
 * geometry `drawFrameToCanvas` used to hard-code — which is why importing a
 * 128 px cell and a 512 px cell produced the same on-screen size before, and
 * still does now.
 */
export function defaultFitPose(w: number, h: number) {
  const s = containScale(w, h, CANVAS_SIZE, CANVAS_SIZE);
  return {
    position: { x: CANVAS_SIZE / 2, y: CANVAS_SIZE / 2 },
    rotation: 0,
    scale: { x: s, y: s },
    pivot: { x: Math.max(1, w) / 2, y: Math.max(1, h) / 2 },
  };
}

/** One source pixel's extent in canvas px, per axis. Used to convert the
 *  stabilizer's source-pixel correction and to size pointer tolerances. */
export function layerPixelScale(layer: Layer): Vec2 {
  return { x: Math.abs(layer.pose.scale.x), y: Math.abs(layer.pose.scale.y) };
}
