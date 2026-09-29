/**
 * Folding pencil strokes into pixels — only for tools that need pixels.
 *
 * Fill and the lasso work on a bitmap, so before they touch a layer its
 * strokes are rendered once at the layer's native resolution into `image`.
 * Nothing else ever bakes: drawing, erasing, zooming, export and playback all
 * render the strokes analytically.
 */

import type { Layer } from "@/types/layer";
import { MAT_IDENTITY } from "@/lib/geometry/mat2d";
import { loadBitmap } from "@/lib/layers/flatten";
import { layerContentBox } from "@/lib/layers/layerSpace";
import { renderStrokes } from "./render";

/** The layer's pixels with its strokes rendered in, as a PNG data URL. */
export async function bakeLayerStrokes(layer: Layer): Promise<string | null> {
  if (typeof document === "undefined") return null;
  const w = Math.max(1, Math.round(layer.size.w));
  const h = Math.max(1, Math.round(layer.size.h));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  if (layer.image) {
    const img = await loadBitmap(layer.image).catch(() => null);
    if (!img) return null;
    ctx.drawImage(img, 0, 0);
  }

  const data = ctx.getImageData(0, 0, w, h);
  renderStrokes(data, 0, 0, layer.strokes ?? [], {
    matrix: MAT_IDENTITY,
    surfaceW: w,
    surfaceH: h,
    clip: layerContentBox(layer),
  });
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL("image/png");
}
