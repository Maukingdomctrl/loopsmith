/**
 * Stage geometry, shared by the editor and the stage worker.
 */

import type { Layer } from "@/types/layer";
import type { Mat2D, Rect } from "@/types/geometry";
import { CANVAS_SIZE } from "@/lib/frameTransform";
import { matApply, matChain, matScale } from "@/lib/geometry/mat2d";
import { layerMatrix } from "@/lib/layers/layerSpace";

/** Layer pixels → stage pixels: the matrix the compositor draws the layer with. */
export function stageMatrix(layer: Layer, size: number): Mat2D {
  const k = size / CANVAS_SIZE;
  return matChain(matScale(k, k), layerMatrix(layer));
}

/** Stage pixels per layer pixel. */
export const stageDensity = (m: Mat2D) => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));

/**
 * The stage pixels a rect of a layer's pixels can change, at stage size
 * `size`: the rect mapped through the matrix the compositor draws the layer
 * with, widened by the reach of its resampling filter (about a layer pixel
 * when the layer is enlarged, more when it is shrunk) and rounded out.
 */
export function stageArea(layer: Layer, r: Rect, size: number): Rect | null {
  const m = stageMatrix(layer, size);
  const pad = 2 + Math.ceil(2 / Math.max(stageDensity(m), 1e-3));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of [
    [r.x - pad, r.y - pad], [r.x + r.w + pad, r.y - pad],
    [r.x - pad, r.y + r.h + pad], [r.x + r.w + pad, r.y + r.h + pad],
  ]) {
    const q = matApply(m, { x, y });
    x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y);
    x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
  }
  const ax = Math.max(0, Math.floor(x0) - 2), ay = Math.max(0, Math.floor(y0) - 2);
  const bx = Math.min(size, Math.ceil(x1) + 2), by = Math.min(size, Math.ceil(y1) + 2);
  return bx > ax && by > ay ? { x: ax, y: ay, w: bx - ax, h: by - ay } : null;
}

/* ---------------- how a decoded image is resampled ---------------- */

/*
 * A decoded <img> drawn on a canvas goes through Chromium's image decode cache
 * when the canvas is rasterized on the CPU: shrunk below half size, the image
 * is first scaled to a mip level (each level halves the size, rounding up),
 * and that is then drawn bilinearly; otherwise the image itself is drawn
 * bilinearly, whatever smoothing quality was asked for. The stage worker draws
 * ImageBitmaps, which skip that cache, so it reproduces it with the numbers
 * below — in float32, as the browser computes them — from mip levels the main
 * thread makes by drawing the <img> itself at the level's size.
 */

const f32 = Math.fround;

/** One axis of an image at a mip level. */
export function mipAxis(size: number, level: number): number {
  return level === 0 ? size : Math.max(1, (size + (1 << level) - 1) >> level);
}

/** The level the cache uses for a target size: the last one not smaller. */
function mipLevel(w: number, h: number, tw: number, th: number): number {
  for (let l = 0; ; l++) {
    if (mipAxis(h, l + 1) < th || mipAxis(w, l + 1) < tw) return l;
    if (mipAxis(w, l) === 1 && mipAxis(h, l) === 1) return l;
  }
}

export interface ImageDrawPlan {
  /** The image pixels the cache works from: the drawn rect, rounded out. */
  readonly src: Rect;
  /** 0: the image itself. */
  readonly level: number;
  /** Size of the level's image. */
  readonly w: number;
  readonly h: number;
}

/** Names a mip level of one image. */
export const levelKey = (p: ImageDrawPlan): string =>
  `${p.level}|${p.src.x},${p.src.y},${p.src.w},${p.src.h}`;

/**
 * How the cache draws the rect `sx, sy, sw, sh` of a `width × height` image
 * onto the same rect under the transform `m`. null: it draws nothing.
 */
export function imageDrawPlan(
  m: Pick<Mat2D, "a" | "b" | "c" | "d">,
  width: number,
  height: number,
  sx: number,
  sy: number,
  sw: number,
  sh: number
): ImageDrawPlan | null {
  const left = f32(sx), top = f32(sy);
  const x0 = Math.max(0, Math.floor(left)), y0 = Math.max(0, Math.floor(top));
  const x1 = Math.min(width, Math.ceil(f32(left + f32(sw))));
  const y1 = Math.min(height, Math.ceil(f32(top + f32(sh))));
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return null;
  const src = { x: x0, y: y0, w, h };

  // The scale, as the cache takes it from the matrix: the diagonal, or the
  // length of each column once the matrix rotates or skews.
  const a = f32(m.a), b = f32(m.b), c = f32(m.c), d = f32(m.d);
  let kx = Math.abs(a), ky = Math.abs(d);
  if (b !== 0 || c !== 0) {
    kx = f32(Math.sqrt(f32(f32(a * a) + f32(b * b))));
    ky = f32(Math.sqrt(f32(f32(c * c) + f32(d * d))));
    // A degenerate matrix: the image itself is drawn.
    const nearlyZero = 1 / 4096;
    if (!Number.isFinite(kx) || !Number.isFinite(ky) || kx <= nearlyZero || ky <= nearlyZero) {
      return { src, level: 0, w, h };
    }
  }
  const tw = Math.floor(f32(f32(w * kx) + 0.5));
  const th = Math.floor(f32(f32(h * ky) + 0.5));
  if (tw <= 0 || th <= 0) return null;
  const level = mipLevel(w, h, tw, th);
  return { src, level, w: mipAxis(w, level), h: mipAxis(h, level) };
}

/** Where the rect `sx, sy, sw, sh` of the image lies on a level's image:
 *  offset to the level's source rect and scaled by its float32 ratio. */
export function levelSrcRect(
  p: ImageDrawPlan,
  sx: number,
  sy: number,
  sw: number,
  sh: number
): [number, number, number, number] {
  const ax = f32(p.w / p.src.w), ay = f32(p.h / p.src.h);
  const left = f32(sx), top = f32(sy);
  const right = f32(left + f32(sw)), bottom = f32(top + f32(sh));
  const l = f32(left - p.src.x), t = f32(top - p.src.y);
  const r = f32(right - p.src.x), b = f32(bottom - p.src.y);
  return [f32(l * ax), f32(t * ay), f32(f32(r - l) * ax), f32(f32(b - t) * ay)];
}
