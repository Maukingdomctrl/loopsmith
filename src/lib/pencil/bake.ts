/**
 * Folding pencil strokes into pixels — only for tools that need pixels.
 *
 * Fill and the pixel brushes work on a bitmap, so the first time they touch a
 * layer its strokes are rendered once at the layer's native resolution.
 * Nothing else ever bakes: drawing, erasing, zooming, export and playback all
 * render the strokes analytically.
 */

import type { Layer } from "@/types/layer";
import { MAT_IDENTITY } from "@/lib/geometry/mat2d";
import { RasterSurface } from "@/lib/raster/surface";
import { layerContentBox } from "@/lib/layers/layerSpace";
import { renderStrokes } from "./render";

/**
 * Render the layer's strokes into `surface` (which holds the layer's pixels),
 * in place. Called at the moment a pixel tool first touches the layer, never
 * just because the tool is selected, so strokes stay sharp until then.
 */
export function bakeStrokesIntoSurface(surface: RasterSurface, layer: Layer): void {
  const strokes = layer.strokes ?? [];
  if (!strokes.length) return;
  const { width: w, height: h } = surface;
  const src = surface.toImageData().data;
  const px = new Uint8ClampedArray(src.length);
  px.set(src);
  renderStrokes({ data: px, width: w, height: h }, 0, 0, strokes, {
    matrix: MAT_IDENTITY,
    surfaceW: w,
    surfaceH: h,
    clip: layerContentBox(layer),
  });
  surface.data.set(RasterSurface.fromImageData(px, w, h).data);
  surface.dirty.add(0, 0, w, h);
}
