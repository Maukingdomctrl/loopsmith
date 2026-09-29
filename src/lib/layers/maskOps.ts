/**
 * Apply Mask: bake a layer's mask into its own pixels (alpha × mask), as
 * Photoshop's "Apply Layer Mask" does. Pencil strokes are baked first, since
 * the result is plain pixels.
 */

import type { Layer } from "@/types/layer";
import { bakeLayerStrokes } from "@/lib/pencil/bake";
import { loadBitmap } from "./flatten";

/** The layer's pixels with its mask applied, as a PNG data URL. null when it
 *  cannot be computed (no DOM, a decode failed). */
export async function applyMaskToPixels(layer: Layer): Promise<string | null> {
  const mask = layer.mask;
  if (!mask || typeof document === "undefined") return null;
  const w = Math.max(1, Math.round(layer.size.w));
  const h = Math.max(1, Math.round(layer.size.h));

  const src = layer.strokes?.length ? await bakeLayerStrokes(layer) : layer.image;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (src) {
    const img = await loadBitmap(src).catch(() => null);
    if (!img) return null;
    ctx.drawImage(img, 0, 0);
  }

  // The mask as coverage 0..255 per pixel, at the layer's size.
  let coverage: Uint8ClampedArray | null = null;
  if (mask.image) {
    const m = await loadBitmap(mask.image).catch(() => null);
    if (!m) return null;
    const mc = document.createElement("canvas");
    mc.width = w;
    mc.height = h;
    const mctx = mc.getContext("2d");
    if (!mctx) return null;
    mctx.drawImage(m, 0, 0, w, h);
    coverage = mctx.getImageData(0, 0, w, h).data;
  }
  const solid = (mask.fill === 255) !== mask.inverted ? 255 : 0;

  const px = ctx.getImageData(0, 0, w, h);
  const d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    let v = coverage ? (coverage[i] * coverage[i + 3]) / 255 : solid;
    if (coverage && mask.inverted) v = 255 - v;
    d[i + 3] = Math.round((d[i + 3] * v) / 255);
  }
  ctx.putImageData(px, 0, 0);
  return canvas.toDataURL("image/png");
}
