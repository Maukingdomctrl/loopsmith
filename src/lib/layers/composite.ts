/**
 * The compositor. THE single place pixels are combined, for every consumer:
 * the on-canvas view, the onion skin, the timeline thumbnail and GIF export.
 *
 * Determinism is the requirement that shapes the design. Given the same layers
 * and the same surface size, this must produce the same bytes every time, on
 * every consumer — otherwise the editor shows one thing and the GIF contains
 * another, which is the failure mode the old four-copies-of-drawFrame
 * arrangement actually had.
 *
 * Consequences, each load-bearing:
 *  - bottom-to-top iteration, always, matching hit-testing's top-to-bottom;
 *  - one setTransform per layer from the SAME Mat2D hit-testing uses;
 *  - alpha/blend applied via ctx state, never by pre-multiplying pixels;
 *  - a non-"normal" blend or a crop forces an isolation buffer, because
 *    Canvas2D blend modes read the whole destination and would otherwise pull
 *    in the checkerboard or the background colour.
 */

import type { Rect } from "@/types/geometry";
import type { CanvasBackground, DocumentCrop, Layer } from "@/types/layer";
import { BLEND_TO_COMPOSITE, isLayerRenderable } from "@/types/layer";
import { CANVAS_SIZE } from "@/lib/frameTransform";
import { matSetTransform, matChain, matScale } from "@/lib/geometry/mat2d";
import { rectIsEmpty, rectNormalize } from "@/lib/geometry/rect";
import { layerContentBox, layerMatrix } from "./layerSpace";

export type Surface2D =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D;

/** Decoded bitmap for one layer. Resolution is the caller's job (it owns the
 *  image cache); the compositor is synchronous so it can run inside a single
 *  animation frame and inside the export loop without await points. */
export interface LayerBitmap {
  readonly layerId: string;
  readonly image: CanvasImageSource;
  readonly width: number;
  readonly height: number;
}

export type BitmapResolver = (layer: Layer) => LayerBitmap | null;

export interface CompositeOptions {
  /** Edge length of the square target surface. */
  readonly surface: number;
  readonly background: CanvasBackground;
  readonly crop: DocumentCrop | null;
  /** View aids. NEVER true for export. */
  readonly drawCheckerboard: boolean;
  /** Global multiplier, used by the onion skin. */
  readonly globalAlpha?: number;
  /** Restrict to these ids (isolation preview). */
  readonly onlyLayerIds?: readonly string[] | null;
  /** Nearest-neighbour keeps pixel art crisp and, more importantly, makes the
   *  output byte-identical across browsers. */
  readonly smoothing?: boolean;
}

export const DEFAULT_COMPOSITE: Omit<CompositeOptions, "background"> = {
  surface: CANVAS_SIZE,
  crop: null,
  drawCheckerboard: false,
  globalAlpha: 1,
  onlyLayerIds: null,
  smoothing: false,
};

export const CHECKER_SIZE = 8;
export const CHECKER_LIGHT = "#2A2F3A";
export const CHECKER_DARK = "#232833";

/** Checkerboard is a VIEW aid. It is drawn beneath the layers and is excluded
 *  from every export path, so a transparent GIF is genuinely transparent. */
export function drawCheckerboard(
  ctx: Surface2D,
  size: number,
  cell: number = CHECKER_SIZE
): void {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = CHECKER_LIGHT;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = CHECKER_DARK;
  for (let y = 0; y < size; y += cell) {
    for (let x = ((y / cell) % 2) * cell; x < size; x += cell * 2) {
      ctx.fillRect(x, y, cell, cell);
    }
  }
  ctx.restore();
}

function createSurface(size: number): {
  ctx: Surface2D;
  canvas: HTMLCanvasElement | OffscreenCanvas;
} | null {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(size, size);
    const ctx = c.getContext("2d", { alpha: true });
    return ctx ? { ctx, canvas: c } : null;
  }
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d", { alpha: true });
  return ctx ? { ctx, canvas: c } : null;
}

/**
 * Composite `layers` onto `ctx`.
 *
 * The context is expected to be `surface × surface`. Document scale is applied
 * as a uniform matrix, so exporting at 128 and viewing at 512 differ by one
 * factor and nothing else — the geometry cannot diverge between the two.
 */
export function compositeLayers(
  ctx: Surface2D,
  layers: readonly Layer[],
  resolve: BitmapResolver,
  options: CompositeOptions
): void {
  const { surface, background, crop } = options;
  const smoothing = options.smoothing ?? false;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, surface, surface);

  if (options.drawCheckerboard && background.checkerboard && background.transparent) {
    drawCheckerboard(ctx, surface);
  }

  // Opaque background is DOCUMENT state and is therefore exported.
  if (!background.transparent) {
    ctx.fillStyle = background.color;
    ctx.fillRect(0, 0, surface, surface);
  }

  const docScale = surface / CANVAS_SIZE;
  const cropRect = crop ? rectNormalize(crop.rect) : null;

  if (cropRect && !rectIsEmpty(cropRect)) {
    ctx.beginPath();
    ctx.rect(
      cropRect.x * docScale,
      cropRect.y * docScale,
      cropRect.w * docScale,
      cropRect.h * docScale
    );
    ctx.clip();
  }

  ctx.globalAlpha = options.globalAlpha ?? 1;
  const allow = options.onlyLayerIds ? new Set(options.onlyLayerIds) : null;

  // Bottom-to-top. The exact mirror of pickTopmost's descent.
  for (const layer of layers) {
    if (!isLayerRenderable(layer)) continue;
    if (allow && !allow.has(layer.id)) continue;

    const bitmap = resolve(layer);
    if (!bitmap) continue;

    drawLayer(ctx, layer, bitmap, docScale, smoothing, options);
  }

  ctx.restore();
}

function drawLayer(
  ctx: Surface2D,
  layer: Layer,
  bitmap: LayerBitmap,
  docScale: number,
  smoothing: boolean,
  options: CompositeOptions
): void {
  const box = layerContentBox(layer);
  if (rectIsEmpty(box)) return;

  const matrix = matChain(matScale(docScale, docScale), layerMatrix(layer));
  const composite = BLEND_TO_COMPOSITE[layer.blend] ?? "source-over";
  const needsIsolation = composite !== "source-over";

  if (!needsIsolation) {
    ctx.save();
    ctx.globalAlpha = (options.globalAlpha ?? 1) * layer.opacity;
    ctx.globalCompositeOperation = "source-over";
    ctx.imageSmoothingEnabled = smoothing;
    if ("imageSmoothingQuality" in ctx) {
      (ctx as CanvasRenderingContext2D).imageSmoothingQuality = "high";
    }
    matSetTransform(ctx as CanvasRenderingContext2D, matrix);
    drawCropped(ctx, bitmap, box);
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }

  // Isolated draw: render the layer alone, then blend the buffer in one go.
  // Blending the layer directly would let the blend mode read the background
  // colour and the checkerboard, which are not part of the layer stack.
  const iso = createSurface(options.surface);
  if (!iso) return;

  iso.ctx.save();
  iso.ctx.imageSmoothingEnabled = smoothing;
  matSetTransform(iso.ctx as CanvasRenderingContext2D, matrix);
  drawCropped(iso.ctx, bitmap, box);
  iso.ctx.restore();

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = (options.globalAlpha ?? 1) * layer.opacity;
  ctx.globalCompositeOperation = composite;
  ctx.drawImage(iso.canvas as CanvasImageSource, 0, 0);
  ctx.restore();
}

/** Draw only the cropped sub-rect, positioned so local coordinates still line
 *  up — a crop must not move the artwork. */
function drawCropped(ctx: Surface2D, bitmap: LayerBitmap, box: Rect): void {
  const sx = Math.max(0, Math.min(box.x, bitmap.width));
  const sy = Math.max(0, Math.min(box.y, bitmap.height));
  const sw = Math.max(0, Math.min(box.w, bitmap.width - sx));
  const sh = Math.max(0, Math.min(box.h, bitmap.height - sy));
  if (sw <= 0 || sh <= 0) return;
  ctx.drawImage(bitmap.image, sx, sy, sw, sh, sx, sy, sw, sh);
}

/** Composite into a fresh surface. Used by flatten, thumbnails and export. */
export function compositeToCanvas(
  layers: readonly Layer[],
  resolve: BitmapResolver,
  options: CompositeOptions
): HTMLCanvasElement | OffscreenCanvas | null {
  const target = createSurface(options.surface);
  if (!target) return null;
  compositeLayers(target.ctx, layers, resolve, {
    ...options,
    drawCheckerboard: false,
  });
  return target.canvas;
}
