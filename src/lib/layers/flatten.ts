/**
 * The flatten cache.
 *
 * `frame.image` keeps its original meaning for every existing consumer —
 * timeline thumbnail, GIF export, the stabilizer's content hash — but it is
 * now DERIVED: the composite of the frame's layers. That is what lets the
 * layer system land without rewriting the stabilizer, the export path or the
 * timeline.
 *
 * Because it is a cache, it must be invalidated precisely. `layerStateKey`
 * hashes every field that can change the pixels and nothing that cannot, so a
 * pure selection change does not trigger a recomposite (which would re-enter
 * the stabilizer's staleness check and mark a good solve stale).
 */

import type { Layer } from "@/types/layer";
import type { Frame } from "@/types/frame";
import type { BitmapResolver, CompositeOptions } from "./composite";
import { compositeToCanvas } from "./composite";
import { CANVAS_SIZE } from "@/lib/frameTransform";
import { DEFAULT_BACKGROUND } from "@/types/layer";
import { roundTo } from "@/lib/geometry/scalar";
import { defaultFitPose } from "./layerSpace";

/** Stable digest of everything that affects the composite. FNV-1a, matching
 *  the algorithm the LSA pipeline already uses for frame content. */
export function layerStateKey(layers: readonly Layer[]): string {
  const parts: string[] = [];
  for (const l of layers) {
    // Poses are rounded to 1e-4 so that floating-point noise from a drag that
    // returned to its origin does not invalidate the cache.
    parts.push(
      l.id,
      l.image ? String(l.image.length) : "0",
      l.visible ? "1" : "0",
      roundTo(l.opacity, 4).toString(),
      l.blend,
      `${l.size.w}x${l.size.h}`,
      l.crop ? `${l.crop.x},${l.crop.y},${l.crop.w},${l.crop.h}` : "-",
      roundTo(l.pose.position.x, 4).toString(),
      roundTo(l.pose.position.y, 4).toString(),
      roundTo(l.pose.rotation, 4).toString(),
      roundTo(l.pose.scale.x, 6).toString(),
      roundTo(l.pose.scale.y, 6).toString(),
      roundTo(l.pose.pivot.x, 4).toString(),
      roundTo(l.pose.pivot.y, 4).toString()
    );
  }
  let h = 0x811c9dc5;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export interface FlattenOptions {
  readonly surface?: number;
  readonly background?: CompositeOptions["background"];
  readonly crop?: CompositeOptions["crop"];
  /** PNG unless a smaller thumbnail is wanted; PNG preserves alpha exactly,
   *  which the stabilizer's premultiplication step depends on. */
  readonly mimeType?: string;
  readonly quality?: number;
}

function toDataURL(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  mime: string,
  quality?: number
): string | null {
  if ("toDataURL" in canvas) {
    return canvas.toDataURL(mime, quality);
  }
  // OffscreenCanvas has no synchronous data-URL path: copy it onto a DOM
  // canvas first. Only a worker (no document) has no way out.
  if (typeof document === "undefined") return null;
  const dom = document.createElement("canvas");
  dom.width = canvas.width;
  dom.height = canvas.height;
  const ctx = dom.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0);
  return dom.toDataURL(mime, quality);
}

/**
 * Composite a frame's layers to a data URL.
 *
 * Runs at NATIVE resolution when every layer shares one bitmap size, so a
 * project of 128 px sprite cells keeps producing 128 px frames. That is not a
 * nicety: the LSA decoder rejects a project whose frames disagree in
 * dimension, and the old lasso path had to downscale 512→128 explicitly for
 * exactly this reason. Here it falls out of the layer sizes.
 */
export function flattenFrame(
  layers: readonly Layer[],
  options: FlattenOptions = {}
): { image: string; key: string; size: { w: number; h: number } } | null {
  const surface = options.surface ?? nativeSurfaceFor(layers);
  const canvas = compositeToCanvas(
    layers,
    domResolver(),
    {
      surface,
      background: options.background ?? DEFAULT_BACKGROUND,
      crop: options.crop ?? null,
      drawCheckerboard: false,
      globalAlpha: 1,
      onlyLayerIds: null,
      smoothing: false,
    }
  );
  if (!canvas) return null;

  const image = toDataURL(canvas, options.mimeType ?? "image/png", options.quality);
  if (!image) return null;

  return { image, key: layerStateKey(layers), size: { w: surface, h: surface } };
}

/** Largest native bitmap edge among the layers, capped at the canvas size.
 *  Preserves sprite-cell resolution without ever upscaling. */
export function nativeSurfaceFor(layers: readonly Layer[]): number {
  let max = 0;
  for (const l of layers) {
    if (!l.image) continue;
    max = Math.max(max, l.size.w, l.size.h);
  }
  return max > 0 ? Math.min(max, CANVAS_SIZE) : CANVAS_SIZE;
}

/* ---------------- bitmap resolution ---------------- */

const bitmapCache = new Map<string, HTMLImageElement>();
const CACHE_LIMIT = 96 * 1024 * 1024;

function trim(): void {
  let bytes = 0;
  for (const img of bitmapCache.values()) bytes += img.width * img.height * 4;
  while (bytes > CACHE_LIMIT && bitmapCache.size > 1) {
    const oldest = bitmapCache.entries().next().value;
    if (!oldest) break;
    bytes -= oldest[1].width * oldest[1].height * 4;
    bitmapCache.delete(oldest[0]);
  }
}

export function getCachedBitmap(src: string): HTMLImageElement | null {
  const hit = bitmapCache.get(src);
  if (!hit || !hit.complete || hit.naturalWidth === 0) return null;
  bitmapCache.delete(src);
  bitmapCache.set(src, hit);
  return hit;
}

export function loadBitmap(src: string): Promise<HTMLImageElement> {
  const cached = getCachedBitmap(src);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      bitmapCache.set(src, img);
      trim();
      resolve(img);
    };
    img.onerror = () => reject(new Error("Failed to decode layer image"));
    img.src = src;
  });
}

/** Synchronous resolver over the cache. Returns null for undecoded layers, so
 *  the compositor simply skips them and the caller repaints on decode. */
export function domResolver(): BitmapResolver {
  return (layer) => {
    if (!layer.image) return null;
    const img = getCachedBitmap(layer.image);
    if (!img) return null;
    return {
      layerId: layer.id,
      image: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
    };
  };
}

/** Decode every layer bitmap in a frame. Awaited before export and before a
 *  flatten, so the composite is never silently missing a layer. */
export async function preloadFrameBitmaps(layers: readonly Layer[]): Promise<void> {
  await Promise.all(
    layers
      .filter((l) => l.image && l.visible)
      .map((l) => loadBitmap(l.image as string).catch(() => null))
  );
}

/** Refresh `frame.image` if, and only if, the layer state actually changed. */
export function reflattenIfStale(frame: Frame): Frame {
  const key = layerStateKey(frame.layers);
  if (frame.flattenKey === key && frame.image) return frame;
  // No pixels anywhere: keep the frame empty so playback and the timeline
  // still treat it as a blank frame.
  if (!frame.layers.some((l) => l.image)) {
    return { ...frame, image: null, flattenKey: key };
  }
  const out = flattenFrame(frame.layers, { crop: frame.crop });
  if (!out) return frame;
  return { ...frame, image: out.image, flattenKey: out.key, flattenedAt: Date.now() };
}

/**
 * Destructively bake the layer stack into the base layer.
 *
 * The one operation that discards layer structure. Offered explicitly (never
 * automatically) because it is the only way to make the lasso's
 * pixel-editing path meet a multi-layer document, and because the animator
 * must be the one to decide that the layers are finished.
 */
export function flattenToBaseLayer(
  layers: readonly Layer[]
): { layers: Layer[]; image: string } | null {
  const out = flattenFrame(layers);
  if (!out) return null;

  const base = layers.find((l) => l.kind === "base") ?? layers[0];
  if (!base) return null;

  return {
    image: out.image,
    layers: [
      {
        ...base,
        image: out.image,
        size: { w: out.size.w, h: out.size.h },
        crop: null,
        opacity: 1,
        visible: true,
        blend: "normal",
        pose: {
          ...defaultFitPose(out.size.w, out.size.h),
          rotation: 0,
        },
      },
    ],
  };
}