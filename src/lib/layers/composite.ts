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
import { resolveGroups } from "./groups";
import type { Mat2D } from "@/types/geometry";
import type { PencilStroke } from "@/lib/pencil/types";
import { LiveStrokeRender, renderStrokes, strokesBounds } from "@/lib/pencil/render";
import { applyAdjustment, isIdentityAdjustment } from "./adjust";

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
  stack: readonly Layer[],
  resolve: BitmapResolver,
  options: CompositeOptions
): void {
  // Groups pass through: drawn as a flat stack with each group's visibility
  // and opacity folded into its layers. Unchanged when there are no groups.
  const layers = resolveGroups(stack);
  const { surface, background, crop } = options;
  const smoothing = options.smoothing ?? false;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, surface, surface);

  if (options.drawCheckerboard && background.checkerboard && background.transparent) {
    // squares keep their on-screen size at any surface density; whole pixels,
    // so neighbouring squares never blend at a fractional edge
    drawCheckerboard(ctx, surface, Math.max(1, Math.round((CHECKER_SIZE * surface) / CANVAS_SIZE)));
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

  // Clipping masks and adjustment layers need the stack built on its own
  // surface. Frames without them keep the direct path below, byte for byte.
  if (layers.some((l) => l.clip || l.adjust)) {
    const stack = compositeStack(layers, resolve, options, docScale, smoothing, allow);
    if (stack) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.drawImage(stack as CanvasImageSource, 0, 0);
    }
    ctx.restore();
    return;
  }

  // Bottom-to-top. The exact mirror of pickTopmost's descent.
  for (const layer of layers) {
    if (!isLayerRenderable(layer)) continue;
    if (allow && !allow.has(layer.id)) continue;

    const bitmap = resolve(layer);
    // Undecoded pixels: skip until they decode (the caller repaints then).
    if (layer.image && !bitmap) continue;
    const mask = layerMask(layer, resolve);
    if (mask === false) continue;

    drawLayer(ctx, layer, bitmap, docScale, smoothing, options, mask);
  }

  ctx.restore();
}

/* ---------------- clipping masks & adjustment layers ---------------- */

/**
 * The layer stack on its own surface, bottom to top.
 *
 * The opaque background (document state) is the bottom of the stack here, so
 * blend modes and adjustments see it exactly as they would in Photoshop; the
 * checkerboard stays outside, on the caller's surface.
 *
 * A layer followed by clipped layers forms a clipping group: the group is
 * built on its own surface (the base layer, then each clipped layer masked to
 * the base's pixels) and composited with the base's opacity and blend.
 */
function compositeStack(
  layers: readonly Layer[],
  resolve: BitmapResolver,
  options: CompositeOptions,
  docScale: number,
  smoothing: boolean,
  allow: Set<string> | null
): HTMLCanvasElement | OffscreenCanvas | null {
  const size = options.surface;
  const stack = createSurface(size);
  if (!stack) return null;
  if (!options.background.transparent) {
    stack.ctx.fillStyle = options.background.color;
    stack.ctx.fillRect(0, 0, size, size);
  }
  const opts: CompositeOptions = { ...options, globalAlpha: 1 };
  const shown = (l: Layer) => l.visible && (!allow || allow.has(l.id));

  let i = 0;
  while (i < layers.length) {
    const layer = layers[i];

    // An adjustment has no pixels to clip to: layers clipped to it simply
    // draw normally, so only the adjustment itself is consumed here.
    if (layer.adjust) {
      if (shown(layer)) applyAdjustTo(stack.ctx, layer, resolve, docScale, smoothing, size);
      i++;
      continue;
    }

    let j = i + 1;
    while (j < layers.length && layers[j].clip) j++;
    const clipped = layers.slice(i + 1, j);
    i = j;

    // A hidden or empty base hides its whole clipping group.
    if (!shown(layer) || !isLayerRenderable(layer)) continue;
    const bitmap = resolve(layer);
    if (layer.image && !bitmap) continue;
    const layerM = layerMask(layer, resolve);
    if (layerM === false) continue;

    if (!clipped.length) {
      drawLayer(stack.ctx, layer, bitmap, docScale, smoothing, opts, layerM);
      continue;
    }

    const group = createSurface(size);
    const mask = createSurface(size);
    if (!group || !mask) continue;
    // The base's own mask shapes the whole group.
    drawLayer(mask.ctx, { ...layer, opacity: 1, blend: "normal" }, bitmap, docScale, smoothing, opts, layerM);
    group.ctx.drawImage(mask.canvas as CanvasImageSource, 0, 0);

    for (const c of clipped) {
      if (!shown(c)) continue;
      if (c.adjust) {
        applyAdjustTo(group.ctx, c, resolve, docScale, smoothing, size);
        continue;
      }
      if (!isLayerRenderable(c)) continue;
      const cb = resolve(c);
      if (c.image && !cb) continue;
      const cm = layerMask(c, resolve);
      if (cm === false) continue;
      const own = createSurface(size);
      if (!own) continue;
      drawLayer(own.ctx, { ...c, blend: "normal" }, cb, docScale, smoothing, opts, cm);
      own.ctx.setTransform(1, 0, 0, 1, 0, 0);
      own.ctx.globalCompositeOperation = "destination-in";
      own.ctx.drawImage(mask.canvas as CanvasImageSource, 0, 0);
      group.ctx.save();
      group.ctx.setTransform(1, 0, 0, 1, 0, 0);
      // Normal paint keeps the base's alpha exactly (source-atop).
      group.ctx.globalCompositeOperation =
        c.blend === "normal" ? "source-atop" : BLEND_TO_COMPOSITE[c.blend] ?? "source-over";
      group.ctx.drawImage(own.canvas as CanvasImageSource, 0, 0);
      group.ctx.restore();
    }

    stack.ctx.save();
    stack.ctx.setTransform(1, 0, 0, 1, 0, 0);
    stack.ctx.globalAlpha = layer.opacity;
    stack.ctx.globalCompositeOperation = BLEND_TO_COMPOSITE[layer.blend] ?? "source-over";
    stack.ctx.drawImage(group.canvas as CanvasImageSource, 0, 0);
    stack.ctx.restore();
  }
  return stack.canvas;
}

/** Run an adjustment layer over everything on `ctx` so far, through its
 *  mask when it has one. */
function applyAdjustTo(
  ctx: Surface2D,
  layer: Layer,
  resolve: BitmapResolver,
  docScale: number,
  smoothing: boolean,
  size: number
): void {
  if (!layer.adjust || layer.opacity <= 0 || isIdentityAdjustment(layer.adjust)) return;
  const mask = layerMask(layer, resolve);
  if (mask === false) return;
  let weights: Uint8ClampedArray | undefined;
  if (mask) {
    const m = createSurface(size);
    if (!m) return;
    m.ctx.imageSmoothingEnabled = smoothing;
    matSetTransform(
      m.ctx as CanvasRenderingContext2D,
      matChain(matScale(docScale, docScale), layerMatrix(layer))
    );
    m.ctx.drawImage(mask, 0, 0, layer.size.w, layer.size.h);
    weights = m.ctx.getImageData(0, 0, size, size).data;
  }
  const img = ctx.getImageData(0, 0, size, size);
  applyAdjustment(img.data, layer.adjust, layer.opacity, weights);
  ctx.putImageData(img, 0, 0);
}

/* ---------------- layer masks ---------------- */

/** Alpha form of decoded mask images (white → opaque), by image + invert. */
const maskAlphaCache = new Map<string, HTMLCanvasElement | OffscreenCanvas>();
const MASK_CACHE_MAX = 64;

/**
 * A layer's mask as an alpha image in layer space.
 *   null  — no masking (no mask, mask off, or a reveal-all mask);
 *   false — draw nothing (hide-all mask, or the mask is still decoding).
 */
export function layerMask(layer: Layer, resolve: BitmapResolver): CanvasImageSource | null | false {
  const m = layer.mask;
  if (!m || !m.enabled) return null;
  if (!m.image) return (m.fill === 255) !== m.inverted ? null : false;

  // The resolver decodes it like any layer image; a preview can substitute
  // its live mask by answering for `<id>#mask`.
  const bmp = resolve({ ...layer, id: `${layer.id}#mask`, image: m.image });
  if (!bmp) return false;

  const cacheable = typeof HTMLImageElement !== "undefined" && bmp.image instanceof HTMLImageElement;
  const key = `${m.inverted ? 1 : 0}|${m.image}`;
  if (cacheable) {
    const hit = maskAlphaCache.get(key);
    if (hit) return hit;
  }
  const out = createSurface(Math.max(bmp.width, bmp.height));
  if (!out) return null;
  const w = bmp.width, h = bmp.height;
  const canvas = out.canvas;
  canvas.width = w;
  canvas.height = h;
  out.ctx.drawImage(bmp.image, 0, 0);
  const img = out.ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    // Grey value (the red channel of a grey mask) becomes coverage.
    const v = (d[i] * d[i + 3]) / 255;
    d[i + 3] = m.inverted ? 255 - v : v;
    d[i] = d[i + 1] = d[i + 2] = 0;
  }
  out.ctx.putImageData(img, 0, 0);
  if (cacheable) {
    maskAlphaCache.set(key, canvas);
    if (maskAlphaCache.size > MASK_CACHE_MAX) {
      maskAlphaCache.delete(maskAlphaCache.keys().next().value as string);
    }
  }
  return canvas;
}

/** Keep only what the mask shows: `surface` already holds the layer drawn in
 *  output space; the mask is drawn through the same layer matrix. */
function applyMask(
  target: Surface2D,
  mask: CanvasImageSource,
  layer: Layer,
  matrix: Mat2D,
  smoothing: boolean
): void {
  target.save();
  target.imageSmoothingEnabled = smoothing;
  matSetTransform(target as CanvasRenderingContext2D, matrix);
  target.globalCompositeOperation = "destination-in";
  target.globalAlpha = 1;
  target.drawImage(mask, 0, 0, layer.size.w, layer.size.h);
  target.restore();
}

function drawLayer(
  ctx: Surface2D,
  layer: Layer,
  bitmap: LayerBitmap | null,
  docScale: number,
  smoothing: boolean,
  options: CompositeOptions,
  mask: CanvasImageSource | null = null
): void {
  const box = layerContentBox(layer);
  if (rectIsEmpty(box)) return;

  const matrix = matChain(matScale(docScale, docScale), layerMatrix(layer));
  const composite = BLEND_TO_COMPOSITE[layer.blend] ?? "source-over";

  if (layer.strokes?.length) {
    let iso: HTMLCanvasElement | OffscreenCanvas | null = layerWithStrokes(
      layer, bitmap, matrix, box, smoothing, options.surface, options.interactive ?? false
    );
    if (!iso) return;
    if (mask) {
      // The stroke render is cached: mask a copy, never the cache.
      const copy = createSurface(options.surface);
      if (!copy) return;
      copy.ctx.drawImage(iso as CanvasImageSource, 0, 0);
      applyMask(copy.ctx, mask, layer, matrix, smoothing);
      iso = copy.canvas;
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = (options.globalAlpha ?? 1) * layer.opacity;
    ctx.globalCompositeOperation = composite;
    ctx.drawImage(iso as CanvasImageSource, 0, 0);
    ctx.restore();
    return;
  }
  if (!bitmap) return;

  const needsIsolation = composite !== "source-over" || !!mask;

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
  if (mask) applyMask(iso.ctx, mask, layer, matrix, smoothing);

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

/** Strokes still being drawn: rendered incrementally (`liveStrokeLayer`),
 *  never cached. */
const liveStrokes = new WeakSet<PencilStroke>();
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

  // A stroke still being drawn is rendered incrementally, never cached.
  const last = strokes[strokes.length - 1];
  if (last && liveStrokes.has(last)) {
    return liveStrokeLayer(key, strokes, base, bitmap, matrix, box, smoothing, surface);
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
  paintLayerStrokes(iso.ctx, base, bitmap, matrix, box, smoothing, surface, strokes);

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
  return iso.canvas;
}

/**
 * Paint a layer with its strokes onto a cleared surface: start from the
 * longest cached render of its leading strokes (else its own pixels) and
 * render the strokes that remain.
 */
function paintLayerStrokes(
  ctx: Surface2D,
  base: StrokeCacheEntry | null,
  bitmap: LayerBitmap | null,
  matrix: Mat2D,
  box: Rect,
  smoothing: boolean,
  surface: number,
  strokes: readonly PencilStroke[]
): void {
  let todo: readonly PencilStroke[] = strokes;
  if (base) {
    ctx.drawImage(base.canvas as CanvasImageSource, 0, 0);
    todo = strokes.slice(base.strokes.length);
  } else if (bitmap) {
    ctx.save();
    ctx.imageSmoothingEnabled = smoothing;
    matSetTransform(ctx as CanvasRenderingContext2D, matrix);
    drawCropped(ctx, bitmap, box);
    ctx.restore();
  }

  const b = strokesBounds(todo, matrix);
  if (b) {
    const x0 = Math.max(0, b.x0), y0 = Math.max(0, b.y0);
    const x1 = Math.min(surface, b.x1), y1 = Math.min(surface, b.y1);
    if (x1 > x0 && y1 > y0) {
      const img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
      renderStrokes(img, x0, y0, todo, {
        matrix,
        surfaceW: surface,
        surfaceH: surface,
        clip: box,
      });
      ctx.putImageData(img, x0, y0);
    }
  }
}

/**
 * The live stroke's layer. Set up once per stroke (and again if the view
 * changes under it): the layer as it lies beneath the stroke is painted and
 * snapshotted, then every frame only applies what the stroke changed — see
 * `LiveStrokeRender`. A frame costs the same at the end of a long stroke as at
 * the start.
 */
interface LiveLayer {
  readonly key: string;
  /** The strokes beneath the live one. */
  readonly under: readonly PencilStroke[];
  readonly ctx: Surface2D;
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly render: LiveStrokeRender;
}

const liveLayers = new WeakMap<PencilStroke, LiveLayer>();

function liveStrokeLayer(
  key: string,
  strokes: readonly PencilStroke[],
  base: StrokeCacheEntry | null,
  bitmap: LayerBitmap | null,
  matrix: Mat2D,
  box: Rect,
  smoothing: boolean,
  surface: number
): HTMLCanvasElement | OffscreenCanvas | null {
  const live = strokes[strokes.length - 1];
  let st = liveLayers.get(live);
  if (!st || st.key !== key || st.under.length !== strokes.length - 1 || !isPrefix(st.under, strokes)) {
    const iso = createSurface(surface);
    if (!iso) return null;
    const under = strokes.slice(0, -1);
    paintLayerStrokes(iso.ctx, base, bitmap, matrix, box, smoothing, surface, under);
    const beneath = iso.ctx.getImageData(0, 0, surface, surface).data;
    st = {
      key,
      under,
      ctx: iso.ctx,
      canvas: iso.canvas,
      render: new LiveStrokeRender(live, { matrix, surfaceW: surface, surfaceH: surface, clip: box }, beneath),
    };
    liveLayers.set(live, st);
  }
  for (const p of st.render.update()) {
    st.ctx.putImageData(new ImageData(p.data, p.width, p.height), p.x, p.y);
  }
  return st.canvas;
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
