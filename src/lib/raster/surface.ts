/**
 * The precision raster engine.
 *
 * DESIGN DECISION 1 — float premultiplied storage.
 * The backing store is a Float32Array of premultiplied RGBA in [0,1], not a
 * Uint8ClampedArray and not an ImageData. A soft brush lays down hundreds of
 * stamps at ~2% alpha each; in 8 bits, `dst = src·a + dst·(1−a)` quantizes at
 * every step and the stroke visibly bands and stalls short of full opacity.
 * In float it converges exactly. Quantization happens once, on commit.
 *
 * DESIGN DECISION 2 — two-buffer strokes.
 * Brush strokes do not draw into the surface. They accumulate a single-channel
 * COVERAGE buffer, which is composited into the surface once when the stroke
 * ends. That is what makes overlapping stamps within one stroke not darken each
 * other, which is the difference between a ribbon and a chain of beads. It also
 * makes a stroke one undo step for free, and makes the eraser a one-line
 * variation instead of a parallel pipeline.
 *
 * DESIGN DECISION 3 — no Canvas2D in the hot path.
 * Nothing here calls into a 2D context. Browsers differ in AA rules, stroke
 * joins and rounding, so a Canvas2D-based engine is not reproducible across
 * them — and this module's output feeds a content hash that the stabilizer
 * treats as identity. DOM canvases appear only at the import/export boundary.
 */

import type { Mat2D, Rect, Vec2 } from "@/types/geometry";
import type { BlendMode, Layer } from "@/types/layer";
import type { DirtyRect, PremultipliedRGBA, RasterCommit, RGBA } from "@/types/raster";
import { matApply, matInvert } from "@/lib/geometry/mat2d";
import { layerMatrix } from "@/lib/layers/layerSpace";
import { RECT_EMPTY, rect, rectIntersect, rectIsEmpty } from "@/lib/geometry/rect";
import { clamp } from "@/lib/geometry/scalar";
import {
  ALPHA_SNAP,
  CHANNELS,
  COVERAGE_EPSILON,
  MAX_SURFACE_EDGE,
} from "./constants";
import { compositeInto, from8, to8, unpremultiply } from "./color";

/* ============================================================ */
/*  DirtyTracker                                                */
/* ============================================================ */

/**
 * Accumulating bounding box of modified pixels.
 *
 * Exists so the integration layer can re-upload a 40×40 region instead of a
 * 512×512 one on every pointer move. Stored as inclusive min/max because that
 * is the natural form for `Math.min`/`Math.max` accumulation; exposed as a
 * half-open Rect because that is what every consumer expects.
 */
export class DirtyTracker {
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;

  add(x0: number, y0: number, x1: number, y1: number): void {
    if (x1 <= x0 || y1 <= y0) return;
    if (x0 < this.minX) this.minX = x0;
    if (y0 < this.minY) this.minY = y0;
    if (x1 > this.maxX) this.maxX = x1;
    if (y1 > this.maxY) this.maxY = y1;
  }

  addRect(r: Rect): void {
    this.add(r.x, r.y, r.x + r.w, r.y + r.h);
  }

  get isEmpty(): boolean {
    return !(this.maxX > this.minX && this.maxY > this.minY);
  }

  toRect(): DirtyRect {
    if (this.isEmpty) return RECT_EMPTY;
    return rect(this.minX, this.minY, this.maxX - this.minX, this.maxY - this.minY);
  }

  reset(): void {
    this.minX = this.minY = Infinity;
    this.maxX = this.maxY = -Infinity;
  }

  clone(): DirtyTracker {
    const d = new DirtyTracker();
    d.minX = this.minX; d.minY = this.minY;
    d.maxX = this.maxX; d.maxY = this.maxY;
    return d;
  }
}

/* ============================================================ */
/*  CoverageBuffer                                              */
/* ============================================================ */

/**
 * Single-channel float mask, 0..1, in surface coordinates.
 *
 * Every drawing primitive in this subsystem — brush stamp, shape SDF, flood
 * fill region — produces a CoverageBuffer and nothing else. Compositing is one
 * function. That is the reason a new tool is ~80 lines rather than a new
 * rendering path with its own blending bugs.
 */
export class CoverageBuffer {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
  readonly dirty = new DirtyTracker();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Float32Array(width * height);
  }

  clear(): void {
    if (this.dirty.isEmpty) return;
    // Clear only the touched rows: a full 512² fill per stroke is 1 MB of
    // pointless writes, and strokes start on every pointerdown.
    const r = this.integerBounds();
    for (let y = r.y; y < r.y + r.h; y++) {
      this.data.fill(0, y * this.width + r.x, y * this.width + r.x + r.w);
    }
    this.dirty.reset();
  }

  /** `max` accumulation — "wet" mode. Overlaps never exceed the stamp alpha. */
  addMax(x: number, y: number, value: number): void {
    if (value <= COVERAGE_EPSILON) return;
    const i = y * this.width + x;
    if (value > this.data[i]) this.data[i] = value > 1 ? 1 : value;
  }

  /** `over` accumulation — "buildup" mode. Converges to 1 asymptotically. */
  addOver(x: number, y: number, value: number): void {
    if (value <= COVERAGE_EPSILON) return;
    const i = y * this.width + x;
    const prev = this.data[i];
    const next = prev + value * (1 - prev);
    this.data[i] = next > 1 ? 1 : next;
  }

  at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.data[y * this.width + x];
  }

  /** Dirty region clipped to the buffer and snapped outward to whole pixels. */
  integerBounds(): Rect {
    const d = this.dirty.toRect();
    if (rectIsEmpty(d)) return RECT_EMPTY;
    const x0 = Math.max(0, Math.floor(d.x));
    const y0 = Math.max(0, Math.floor(d.y));
    const x1 = Math.min(this.width, Math.ceil(d.x + d.w));
    const y1 = Math.min(this.height, Math.ceil(d.y + d.h));
    return x1 > x0 && y1 > y0 ? rect(x0, y0, x1 - x0, y1 - y0) : RECT_EMPTY;
  }

  /**
   * Separable box blur, N passes — the feather operator.
   *
   * Three box passes approximate a Gaussian to within 3% (central limit), at a
   * fraction of the cost and with no kernel to store. Fixed pass count keeps
   * it deterministic.
   */
  feather(radius: number, passes = 3): void {
    if (radius < 0.5) return;
    const r = Math.max(1, Math.round(radius));
    const bounds = this.integerBounds();
    if (rectIsEmpty(bounds)) return;

    // Grow the working area so the blur can spread outward.
    const x0 = Math.max(0, bounds.x - r * passes);
    const y0 = Math.max(0, bounds.y - r * passes);
    const x1 = Math.min(this.width, bounds.x + bounds.w + r * passes);
    const y1 = Math.min(this.height, bounds.y + bounds.h + r * passes);
    this.dirty.add(x0, y0, x1, y1);

    const tmp = new Float32Array(this.data.length);
    const win = 2 * r + 1;

    for (let p = 0; p < passes; p++) {
      // Horizontal
      for (let y = y0; y < y1; y++) {
        const row = y * this.width;
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += this.sampleClamped(row, x0 + k, x0, x1);
        for (let x = x0; x < x1; x++) {
          tmp[row + x] = sum / win;
          sum += this.sampleClamped(row, x + r + 1, x0, x1);
          sum -= this.sampleClamped(row, x - r, x0, x1);
        }
      }
      // Vertical
      for (let x = x0; x < x1; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) {
          sum += tmp[clamp(y0 + k, y0, x1 > 0 ? y1 - 1 : 0) * this.width + x];
        }
        for (let y = y0; y < y1; y++) {
          this.data[y * this.width + x] = sum / win;
          const addY = clamp(y + r + 1, y0, y1 - 1);
          const subY = clamp(y - r, y0, y1 - 1);
          sum += tmp[addY * this.width + x];
          sum -= tmp[subY * this.width + x];
        }
      }
    }
  }

  private sampleClamped(row: number, x: number, x0: number, x1: number): number {
    return this.data[row + clamp(x, x0, x1 - 1)];
  }

  /**
   * Morphological dilation by a disc — the flood fill's "grow".
   *
   * Two-pass Chebyshev/chamfer approximation of the Euclidean distance
   * transform, thresholded. Exact Euclidean dilation would need a full EDT;
   * the chamfer error is under half a pixel, which is invisible at the radii
   * this is used for (≤32 px) and an order of magnitude cheaper.
   */
  dilate(radius: number): void {
    const r = Math.round(radius);
    if (r < 1) return;
    const bounds = this.integerBounds();
    if (rectIsEmpty(bounds)) return;

    const x0 = Math.max(0, bounds.x - r);
    const y0 = Math.max(0, bounds.y - r);
    const x1 = Math.min(this.width, bounds.x + bounds.w + r);
    const y1 = Math.min(this.height, bounds.y + bounds.h + r);
    this.dirty.add(x0, y0, x1, y1);

    const BIG = 1e9;
    const dist = new Float32Array((x1 - x0) * (y1 - y0));
    const w = x1 - x0;
    const D1 = 1, D2 = Math.SQRT2;

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        dist[(y - y0) * w + (x - x0)] =
          this.data[y * this.width + x] > 0.5 ? 0 : BIG;
      }
    }
    // Forward pass
    for (let y = 0; y < y1 - y0; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let d = dist[i];
        if (x > 0) d = Math.min(d, dist[i - 1] + D1);
        if (y > 0) d = Math.min(d, dist[i - w] + D1);
        if (x > 0 && y > 0) d = Math.min(d, dist[i - w - 1] + D2);
        if (x < w - 1 && y > 0) d = Math.min(d, dist[i - w + 1] + D2);
        dist[i] = d;
      }
    }
    // Backward pass
    for (let y = y1 - y0 - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const i = y * w + x;
        let d = dist[i];
        if (x < w - 1) d = Math.min(d, dist[i + 1] + D1);
        if (y < y1 - y0 - 1) d = Math.min(d, dist[i + w] + D1);
        if (x < w - 1 && y < y1 - y0 - 1) d = Math.min(d, dist[i + w + 1] + D2);
        if (x > 0 && y < y1 - y0 - 1) d = Math.min(d, dist[i + w - 1] + D2);
        dist[i] = d;
      }
    }
    // Threshold with a one-pixel analytic AA band at the new boundary.
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const d = dist[(y - y0) * w + (x - x0)];
        const cov = clamp(r + 0.5 - d, 0, 1);
        const i = y * this.width + x;
        if (cov > this.data[i]) this.data[i] = cov;
      }
    }
  }
}

/* ============================================================ */
/*  RasterSurface                                               */
/* ============================================================ */

export interface SurfaceSnapshot {
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
}

export class RasterSurface {
  readonly width: number;
  readonly height: number;
  /** Premultiplied RGBA, 0..1, row-major, 4 floats per pixel. */
  readonly data: Float32Array;
  readonly dirty = new DirtyTracker();

  constructor(width: number, height: number) {
    if (
      !Number.isInteger(width) || !Number.isInteger(height) ||
      width <= 0 || height <= 0 ||
      width > MAX_SURFACE_EDGE || height > MAX_SURFACE_EDGE
    ) {
      throw new Error(`RasterSurface: invalid size ${width}×${height}`);
    }
    this.width = width;
    this.height = height;
    this.data = new Float32Array(width * height * CHANNELS);
  }

  /* ---------- construction ---------- */

  /** Adopt 8-bit NON-premultiplied RGBA, as `getImageData` returns it. */
  static fromImageData(
    src: Uint8ClampedArray,
    width: number,
    height: number
  ): RasterSurface {
    const s = new RasterSurface(width, height);
    const n = width * height;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const a = src[p + 3] / 255;
      // Premultiply on ingest, so the internal invariant holds from pixel one.
      s.data[p]     = (src[p]     / 255) * a;
      s.data[p + 1] = (src[p + 1] / 255) * a;
      s.data[p + 2] = (src[p + 2] / 255) * a;
      s.data[p + 3] = a;
    }
    s.dirty.add(0, 0, width, height);
    return s;
  }

  /**
   * Decode a layer's bitmap into a surface.
   *
   * The ONLY DOM touchpoint in the engine, and it is at the boundary by
   * design: everything downstream is pure arithmetic over typed arrays and is
   * therefore testable in Node and reproducible across browsers.
   */
  static async fromLayer(layer: Layer): Promise<RasterSurface> {
    const w = Math.max(1, Math.round(layer.size.w));
    const h = Math.max(1, Math.round(layer.size.h));
    if (!layer.image) return new RasterSurface(w, h);

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("raster: failed to decode layer image"));
      el.src = layer.image as string;
    });

    const cw = img.naturalWidth || w;
    const ch = img.naturalHeight || h;
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return new RasterSurface(cw, ch);

    // No smoothing, no transform: a 1:1 blit. Any resampling here would make
    // paint-commit-paint lossy.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, cw, ch).data;
    return RasterSurface.fromImageData(data, cw, ch);
  }

  /* ---------- access ---------- */

  index(x: number, y: number): number {
    return (y * this.width + x) * CHANNELS;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  /** Premultiplied read. Out of bounds is transparent, never wrapped. */
  getPremultiplied(x: number, y: number): PremultipliedRGBA {
    if (!this.inBounds(x, y)) return { r: 0, g: 0, b: 0, a: 0 };
    const i = this.index(x, y);
    return { r: this.data[i], g: this.data[i + 1], b: this.data[i + 2], a: this.data[i + 3] };
  }

  /** Straight read — what a user-facing sample means. */
  getColor(x: number, y: number): RGBA {
    return unpremultiply(this.getPremultiplied(x, y));
  }

  setColor(x: number, y: number, c: RGBA): void {
    if (!this.inBounds(x, y)) return;
    const i = this.index(x, y);
    this.data[i]     = c.r * c.a;
    this.data[i + 1] = c.g * c.a;
    this.data[i + 2] = c.b * c.a;
    this.data[i + 3] = c.a;
    this.dirty.add(x, y, x + 1, y + 1);
  }

  /* ---------- bulk operations ---------- */

  clear(region?: Rect): void {
    const r = region ? this.clipRect(region) : rect(0, 0, this.width, this.height);
    if (rectIsEmpty(r)) return;
    for (let y = r.y; y < r.y + r.h; y++) {
      const start = this.index(r.x, y);
      this.data.fill(0, start, start + r.w * CHANNELS);
    }
    this.dirty.addRect(r);
  }

  fill(color: RGBA, region?: Rect): void {
    const r = region ? this.clipRect(region) : rect(0, 0, this.width, this.height);
    if (rectIsEmpty(r)) return;
    const pr = color.r * color.a, pg = color.g * color.a, pb = color.b * color.a;
    for (let y = r.y; y < r.y + r.h; y++) {
      let i = this.index(r.x, y);
      for (let x = 0; x < r.w; x++, i += CHANNELS) {
        this.data[i] = pr; this.data[i + 1] = pg;
        this.data[i + 2] = pb; this.data[i + 3] = color.a;
      }
    }
    this.dirty.addRect(r);
  }

  /**
   * Composite a coverage buffer with a solid colour — the universal paint step.
   *
   * Every tool funnels through here. `alphaScale` carries stroke opacity, so
   * the coverage buffer stays a pure geometric mask and the same mask can be
   * re-composited at a different opacity without re-rasterizing.
   */
  compositeCoverage(
    coverage: CoverageBuffer,
    color: RGBA,
    alphaScale: number,
    mode: BlendMode,
    region?: Rect
  ): void {
    const bounds = region
      ? rectIntersect(coverage.integerBounds(), this.clipRect(region))
      : coverage.integerBounds();
    if (rectIsEmpty(bounds)) return;

    const sr = color.r, sg = color.g, sb = color.b;
    const scale = clamp(alphaScale, 0, 1) * clamp(color.a, 0, 1);
    if (scale <= 0) return;

    for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
      const crow = y * coverage.width;
      let i = this.index(bounds.x, y);
      for (let x = bounds.x; x < bounds.x + bounds.w; x++, i += CHANNELS) {
        const cov = coverage.data[crow + x];
        if (cov <= COVERAGE_EPSILON) continue;
        compositeInto(this.data, i, sr, sg, sb, cov * scale, mode);
      }
    }
    this.dirty.addRect(bounds);
  }

  /**
   * TRUE ALPHA ERASE — `destination-out` semantics.
   *
   * Because storage is premultiplied, scaling all four channels by (1 − a)
   * IS the correct destination-out: it reduces alpha and keeps the
   * un-premultiplied colour exactly constant. Scaling only the alpha channel
   * — the obvious-looking mistake — leaves colour over-weighted and produces
   * the bright fringe that plagues hand-rolled erasers.
   */
  eraseCoverage(
    coverage: CoverageBuffer,
    strength: number,
    region?: Rect
  ): void {
    const bounds = region
      ? rectIntersect(coverage.integerBounds(), this.clipRect(region))
      : coverage.integerBounds();
    if (rectIsEmpty(bounds)) return;

    const s = clamp(strength, 0, 1);
    if (s <= 0) return;

    for (let y = bounds.y; y < bounds.y + bounds.h; y++) {
      const crow = y * coverage.width;
      let i = this.index(bounds.x, y);
      for (let x = bounds.x; x < bounds.x + bounds.w; x++, i += CHANNELS) {
        const cov = coverage.data[crow + x];
        if (cov <= COVERAGE_EPSILON) continue;
        const keep = 1 - cov * s;
        if (keep <= 0) {
          this.data[i] = this.data[i + 1] = this.data[i + 2] = this.data[i + 3] = 0;
        } else {
          this.data[i] *= keep; this.data[i + 1] *= keep;
          this.data[i + 2] *= keep; this.data[i + 3] *= keep;
        }
      }
    }
    this.dirty.addRect(bounds);
  }

  /**
   * Alpha lock: put back the alpha each pixel had in `before` (a copy of
   * `data` taken before painting), keeping the new colour. Paint then only
   * recolours pixels that were already there — transparent stays transparent.
   */
  keepAlpha(before: Float32Array, region: Rect): void {
    const r = this.clipRect(region);
    if (rectIsEmpty(r)) return;
    for (let y = r.y; y < r.y + r.h; y++) {
      let i = this.index(r.x, y);
      for (let x = r.x; x < r.x + r.w; x++, i += CHANNELS) {
        const a0 = before[i + 3];
        const a1 = this.data[i + 3];
        if (a0 <= 0 || a1 <= 0) {
          this.data[i] = this.data[i + 1] = this.data[i + 2] = this.data[i + 3] = 0;
          continue;
        }
        if (a0 === a1) continue;
        const k = a0 / a1;
        this.data[i] *= k; this.data[i + 1] *= k;
        this.data[i + 2] *= k; this.data[i + 3] = a0;
      }
    }
    this.dirty.addRect(r);
  }

  /** Keep only what the coverage covers — `destination-in`, for clipping. */
  maskCoverage(coverage: CoverageBuffer): void {
    for (let y = 0; y < this.height; y++) {
      const crow = y * coverage.width;
      let i = this.index(0, y);
      for (let x = 0; x < this.width; x++, i += CHANNELS) {
        const k = coverage.data[crow + x];
        this.data[i] *= k; this.data[i + 1] *= k;
        this.data[i + 2] *= k; this.data[i + 3] *= k;
      }
    }
    this.dirty.add(0, 0, this.width, this.height);
  }

  /* ---------- snapshots ---------- */

  /** Full copy. Used for stroke-level undo within a session. */
  snapshot(): SurfaceSnapshot {
    return { data: this.data.slice(), width: this.width, height: this.height };
  }

  /** Region copy — the cheap path, since a stroke touches a small fraction. */
  snapshotRegion(region: Rect): { rect: Rect; data: Float32Array } | null {
    const r = this.clipRect(region);
    if (rectIsEmpty(r)) return null;
    const out = new Float32Array(r.w * r.h * CHANNELS);
    for (let y = 0; y < r.h; y++) {
      const src = this.index(r.x, r.y + y);
      out.set(this.data.subarray(src, src + r.w * CHANNELS), y * r.w * CHANNELS);
    }
    return { rect: r, data: out };
  }

  restore(snap: SurfaceSnapshot): void {
    if (snap.width !== this.width || snap.height !== this.height) {
      throw new Error("RasterSurface.restore: dimension mismatch");
    }
    this.data.set(snap.data);
    this.dirty.add(0, 0, this.width, this.height);
  }

  restoreRegion(snap: { rect: Rect; data: Float32Array }): void {
    const r = snap.rect;
    for (let y = 0; y < r.h; y++) {
      this.data.set(
        snap.data.subarray(y * r.w * CHANNELS, (y + 1) * r.w * CHANNELS),
        this.index(r.x, r.y + y)
      );
    }
    this.dirty.addRect(r);
  }

  /* ---------- output ---------- */

  /**
   * Quantize to 8-bit straight RGBA.
   *
   * ALPHA_SNAP matters here: a float alpha of 1e-7 left behind by an erase
   * would round to 0 anyway, but its un-premultiplied colour is a division by
   * 1e-7 — numerically explosive. Snapping first keeps the output clean and
   * makes erased regions bit-exactly transparent, which the LSA decoder's
   * premultiplication step relies on.
   *
   * `region` converts just that rect (the same bytes the full conversion
   * would give there) — what a live preview needs after a stroke changes a
   * few pixels of a large surface.
   */
  toImageData(region?: Rect): { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
    const r = region ? this.clipRect(region) : rect(0, 0, this.width, this.height);
    const out = new Uint8ClampedArray(new ArrayBuffer(r.w * r.h * 4));
    for (let y = 0; y < r.h; y++) {
      let p = this.index(r.x, r.y + y);
      let q = y * r.w * 4;
      for (let x = 0; x < r.w; x++, p += CHANNELS, q += 4) {
        const a = this.data[p + 3];
        if (a <= ALPHA_SNAP) continue; // leaves 0,0,0,0
        const inv = 1 / a;
        out[q]     = to8(this.data[p]     * inv);
        out[q + 1] = to8(this.data[p + 1] * inv);
        out[q + 2] = to8(this.data[p + 2] * inv);
        out[q + 3] = to8(a);
      }
    }
    return { data: out, width: r.w, height: r.h };
  }

  /** Commit to a PNG data URL, ready for `layer/setImage`. */
commit(): RasterCommit | null {
  if (typeof document === "undefined") return null;

  const { data } = this.toImageData();

  const canvas = document.createElement("canvas");
  canvas.width = this.width;
  canvas.height = this.height;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const pixels = new Uint8ClampedArray(new ArrayBuffer(data.length));
pixels.set(data);

ctx.putImageData(
  new ImageData(pixels, this.width, this.height),
  0,
  0
);

  const dirty = this.dirty.toRect();
  this.dirty.reset();

  // PNG, always: alpha must survive losslessly.
  return {
    dirty,
    image: canvas.toDataURL("image/png"),
    width: this.width,
    height: this.height,
  };
}

  /** Tight bounds of non-transparent pixels. Feeds "crop to content". */
  alphaBounds(threshold = 0): Rect {
    let minX = this.width, minY = this.height, maxX = -1, maxY = -1;
    for (let y = 0; y < this.height; y++) {
      let i = this.index(0, y) + 3;
      for (let x = 0; x < this.width; x++, i += CHANNELS) {
        if (this.data[i] > threshold) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return maxX < 0 ? RECT_EMPTY : rect(minX, minY, maxX - minX + 1, maxY - minY + 1);
  }

  clipRect(r: Rect): Rect {
    const x0 = Math.max(0, Math.floor(r.x));
    const y0 = Math.max(0, Math.floor(r.y));
    const x1 = Math.min(this.width, Math.ceil(r.x + r.w));
    const y1 = Math.min(this.height, Math.ceil(r.y + r.h));
    return x1 > x0 && y1 > y0 ? rect(x0, y0, x1 - x0, y1 - y0) : RECT_EMPTY;
  }

  createCoverage(): CoverageBuffer {
    return new CoverageBuffer(this.width, this.height);
  }
}

/* ============================================================ */
/*  coordinate bridge                                           */
/* ============================================================ */

/**
 * Canvas-space point → layer-local pixel coordinates.
 *
 * The single conversion the integration layer needs, and the reason this
 * module composes with the existing geometry core rather than duplicating it:
 * it is literally the layer matrix's inverse, the same one used for
 * hit-testing, so paint lands exactly where the cursor tested.
 */
export function canvasPointToLocal(layer: Layer, p: Vec2): Vec2 | null {
  const inv = matInvert(layerMatrix(layer));
  return inv ? matApply(inv, p) : null;
}

export function localPointToCanvas(layer: Layer, p: Vec2): Vec2 {
  return matApply(layerMatrix(layer), p);
}

/**
 * Brush radius in canvas px, given a local radius.
 *
 * Needed by the cursor, and by the caller that wants a screen-constant brush
 * size. Uses the geometric mean of the axis scales so a non-uniformly scaled
 * layer yields one sensible number rather than an ellipse the UI cannot draw.
 */
export function localRadiusToCanvas(layer: Layer, radius: number): number {
  const sx = Math.abs(layer.pose.scale.x);
  const sy = Math.abs(layer.pose.scale.y);
  return radius * Math.sqrt(Math.max(1e-12, sx * sy));
}

export function canvasRadiusToLocal(layer: Layer, radius: number): number {
  const sx = Math.abs(layer.pose.scale.x);
  const sy = Math.abs(layer.pose.scale.y);
  const s = Math.sqrt(Math.max(1e-12, sx * sy));
  return s > 0 ? radius / s : radius;
}

/** Local-space matrix for a rotated stamp or shape. Exported so shapes.ts and
 *  brush.ts share one construction. */
export function stampMatrix(center: Vec2, angleRad: number, sx: number, sy: number): Mat2D {
  const cos = Math.cos(angleRad), sin = Math.sin(angleRad);
  return {
    a: cos * sx, b: sin * sx,
    c: -sin * sy, d: cos * sy,
    e: center.x, f: center.y,
  };
}
    