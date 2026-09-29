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
import { matSetTransform, matChain, matScale, matInvert } from "@/lib/geometry/mat2d";
import { rectIsEmpty, rectNormalize } from "@/lib/geometry/rect";
import { layerContentBox, layerMatrix } from "./layerSpace";
import type { Mat2D } from "@/types/geometry";
import type { PencilStroke } from "@/lib/pencil/types";
import { LiveStrokeRaster, renderStrokes, strokesBounds } from "@/lib/pencil/render";

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
  /** Interactive view (not export): while the view is changing, pencil
   *  layers may show a resampled stand-in and refine a moment later. */
  readonly interactive?: boolean;
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
    // Hi-DPI views keep the same on-screen checker size.
    drawCheckerboard(ctx, surface, CHECKER_SIZE * Math.max(1, surface / CANVAS_SIZE));
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
    // Undecoded pixels: skip until they decode (the caller repaints then).
    if (layer.image && !bitmap) continue;

    drawLayer(ctx, layer, bitmap, docScale, smoothing, options);
  }

  ctx.restore();
}

function drawLayer(
  ctx: Surface2D,
  layer: Layer,
  bitmap: LayerBitmap | null,
  docScale: number,
  smoothing: boolean,
  options: CompositeOptions
): void {
  const box = layerContentBox(layer);
  if (rectIsEmpty(box)) return;

  const matrix = matChain(matScale(docScale, docScale), layerMatrix(layer));
  const composite = BLEND_TO_COMPOSITE[layer.blend] ?? "source-over";

  if (layer.strokes?.length) {
    const iso = layerWithStrokes(
      layer, bitmap, matrix, box, smoothing, options.surface, options.interactive ?? false
    );
    if (!iso) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = (options.globalAlpha ?? 1) * layer.opacity;
    ctx.globalCompositeOperation = composite;
    ctx.drawImage(iso as CanvasImageSource, 0, 0);
    ctx.restore();
    return;
  }
  if (!bitmap) return;

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

/* ---------------- pencil strokes ---------------- */

/**
 * Pencil strokes are rendered analytically, at this surface's resolution, on
 * top of the layer's own pixels, in an isolation buffer (erase strokes must
 * remove imported pixels too, and nothing beneath the layer).
 *
 * Rendering is a pure function of (pixels, strokes, matrix, surface), so the
 * result is cached. A layer whose stroke list EXTENDS a cached one reuses it
 * and renders only the new strokes — which is what keeps live drawing and
 * pen-up cheap however many strokes the layer already holds.
 */
interface StrokeCacheEntry {
  readonly strokes: readonly PencilStroke[];
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
}

const strokeCache = new Map<string, StrokeCacheEntry[]>();
const STROKE_CACHE_MAX = 48;
let strokeCacheCount = 0;

/** The last exact render of each layer, for interactive stand-ins. */
const lastExact = new Map<
  string,
  {
    readonly strokes: readonly PencilStroke[];
    readonly image: string | null;
    readonly matrix: Mat2D;
    readonly surface: number;
    readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  }
>();
const refineTimers = new Map<string, ReturnType<typeof setTimeout>>();
const refineListeners = new Set<() => void>();
/** Refinement delay after the view stops changing. */
const REFINE_MS = 150;

/** Called when a deferred exact render has landed; the view should repaint. */
export function onStrokeRefine(cb: () => void): () => void {
  refineListeners.add(cb);
  return () => {
    refineListeners.delete(cb);
  };
}

/** Strokes still being drawn: rendered, never cached. */
const liveStrokes = new WeakSet<PencilStroke>();

/** The stroke being drawn: rendered incrementally into its own canvas. */
let live: {
  stroke: PencilStroke;
  key: string;
  raster: LiveStrokeRaster;
  surface: { ctx: Surface2D; canvas: HTMLCanvasElement | OffscreenCanvas };
} | null = null;

function liveStrokeCanvas(
  stroke: PencilStroke, matrix: Mat2D, surface: number, clip: Rect
): HTMLCanvasElement | OffscreenCanvas | null {
  const m = matrix;
  const key = `${m.a},${m.b},${m.c},${m.d},${m.e},${m.f}|${surface}|${clip.x},${clip.y},${clip.w},${clip.h}`;
  if (!live || live.stroke !== stroke || live.key !== key) {
    const buf = createSurface(surface);
    if (!buf) return null;
    live = {
      stroke,
      key,
      raster: new LiveStrokeRaster(stroke, { matrix, surfaceW: surface, surfaceH: surface, clip }),
      surface: buf,
    };
  }
  const up = live.raster.update();
  if (up) {
    const img = new ImageData(up.data as Uint8ClampedArray<ArrayBuffer>, up.w, up.h);
    (live.surface.ctx as CanvasRenderingContext2D).putImageData(img, up.x0, up.y0);
  }
  return live.surface.canvas;
}
export const markLiveStroke = (s: PencilStroke) => liveStrokes.add(s);

function isPrefix(a: readonly PencilStroke[], b: readonly PencilStroke[]): boolean {
  if (a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function layerWithStrokes(
  layer: Layer,
  bitmap: LayerBitmap | null,
  matrix: Mat2D,
  box: Rect,
  smoothing: boolean,
  surface: number,
  interactive: boolean
): HTMLCanvasElement | OffscreenCanvas | null {
  const strokes = layer.strokes ?? [];
  const m = matrix;
  const key = [
    layer.id,
    layer.image ? `${layer.image.length}:${layer.image.slice(-32)}` : "-",
    `${m.a},${m.b},${m.c},${m.d},${m.e},${m.f}`,
    surface,
    `${box.x},${box.y},${box.w},${box.h}`,
    smoothing ? 1 : 0,
  ].join("|");

  const entries = strokeCache.get(key) ?? [];
  let base: StrokeCacheEntry | null = null;
  for (const e of entries) {
    if (e.strokes === strokes) {
      lastExact.set(layer.id, { strokes, image: layer.image, matrix, surface, canvas: e.canvas });
      return e.canvas;
    }
    if (isPrefix(e.strokes, strokes) && (!base || e.strokes.length > base.strokes.length)) base = e;
  }

  // The view is changing (zoom, move, rotate): stretch the last exact render
  // for now and render exactly once it settles. Rendering every intermediate
  // step of a zoom drag would stall it.
  if (!base && interactive) {
    const prev = lastExact.get(layer.id);
    const inv = prev ? matInvert(prev.matrix) : null;
    if (prev && inv && prev.strokes === strokes && prev.image === layer.image && prev.surface === surface) {
      const stand = createSurface(surface);
      if (stand) {
        stand.ctx.save();
        stand.ctx.imageSmoothingEnabled = true;
        matSetTransform(stand.ctx as CanvasRenderingContext2D, matChain(matrix, inv));
        stand.ctx.drawImage(prev.canvas as CanvasImageSource, 0, 0);
        stand.ctx.restore();
        clearTimeout(refineTimers.get(layer.id));
        refineTimers.set(
          layer.id,
          setTimeout(() => {
            refineTimers.delete(layer.id);
            layerWithStrokes(layer, bitmap, matrix, box, smoothing, surface, false);
            refineListeners.forEach((cb) => cb());
          }, REFINE_MS)
        );
        return stand.canvas;
      }
    }
  }

  const iso = createSurface(surface);
  if (!iso) return null;
  let todo: readonly PencilStroke[] = strokes;
  if (base) {
    iso.ctx.drawImage(base.canvas as CanvasImageSource, 0, 0);
    todo = strokes.slice(base.strokes.length);
  } else if (bitmap) {
    iso.ctx.save();
    iso.ctx.imageSmoothingEnabled = smoothing;
    matSetTransform(iso.ctx as CanvasRenderingContext2D, matrix);
    drawCropped(iso.ctx, bitmap, box);
    iso.ctx.restore();
  }

  const liveOnly = todo.length === 1 && liveStrokes.has(todo[0]);
  const liveCanvas = liveOnly ? liveStrokeCanvas(todo[0], matrix, surface, box) : null;
  if (liveCanvas) {
    // Same result as renderStrokes: colour over, or (erase) alpha removed.
    iso.ctx.save();
    iso.ctx.globalCompositeOperation = todo[0].kind === "erase" ? "destination-out" : "source-over";
    iso.ctx.drawImage(liveCanvas as CanvasImageSource, 0, 0);
    iso.ctx.restore();
  }
  const b = liveCanvas ? null : strokesBounds(todo, matrix);
  if (b) {
    const x0 = Math.max(0, b.x0), y0 = Math.max(0, b.y0);
    const x1 = Math.min(surface, b.x1), y1 = Math.min(surface, b.y1);
    if (x1 > x0 && y1 > y0) {
      const img = iso.ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
      renderStrokes(img, x0, y0, todo, {
        matrix,
        surfaceW: surface,
        surfaceH: surface,
        clip: box,
      });
      iso.ctx.putImageData(img, x0, y0);
    }
  }

  const last = strokes[strokes.length - 1];
  if (!last || !liveStrokes.has(last)) {
    lastExact.set(layer.id, { strokes, image: layer.image, matrix, surface, canvas: iso.canvas });
    if (lastExact.size > STROKE_CACHE_MAX) lastExact.delete(lastExact.keys().next().value as string);
    entries.push({ strokes, canvas: iso.canvas });
    strokeCache.delete(key);
    strokeCache.set(key, entries);
    strokeCacheCount++;
    // Keep the newest few per key and a bounded total.
    if (entries.length > 3) {
      entries.shift();
      strokeCacheCount--;
    }
    while (strokeCacheCount > STROKE_CACHE_MAX) {
      const oldestKey = strokeCache.keys().next().value as string;
      const list = strokeCache.get(oldestKey)!;
      list.shift();
      strokeCacheCount--;
      if (!list.length) strokeCache.delete(oldestKey);
    }
  }
  return iso.canvas;
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
