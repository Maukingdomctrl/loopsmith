/**
 * Scanline flood fill.
 *
 * SPAN-BASED, AND ITERATIVE. Two decisions, both necessary:
 *
 *  - Not recursive. A 512×512 region is up to 262 144 pixels deep in the worst
 *    case, which overflows the JS call stack long before it finishes.
 *  - Not per-pixel queued. The classic four-neighbour queue pushes one entry
 *    per pixel; the span algorithm pushes one entry per horizontal RUN, which
 *    for typical artwork is 20–100× fewer stack operations and far better
 *    cache locality because each run is a contiguous sweep.
 *
 * Traversal order is fixed (left-to-right within a row, spans popped LIFO), so
 * the output is deterministic — which matters because the result feeds a
 * content hash.
 */

import type { Rect, Vec2 } from "@/types/geometry";
import type { FloodFillResult, FloodFillSettings } from "@/types/raster";
import { CoverageBuffer, RasterSurface } from "./surface";
import { RECT_EMPTY, rect } from "@/lib/geometry/rect";
import { clamp } from "@/lib/geometry/scalar";
import { colorDistance } from "./color";
import {
  CHANNELS,
  FILL_MAX_SPANS,
  FILL_STACK_INITIAL,
  FILL_WEIGHT_A,
  FILL_WEIGHT_B,
  FILL_WEIGHT_G,
  FILL_WEIGHT_R,
  MAX_FILL_FEATHER,
  MAX_FILL_GROW,
} from "./constants";

/** Explicit span stack. Typed arrays, grown geometrically — no allocation per span. */
class SpanStack {
  private xs = new Int32Array(FILL_STACK_INITIAL);
  private xe = new Int32Array(FILL_STACK_INITIAL);
  private ys = new Int32Array(FILL_STACK_INITIAL);
  private dy = new Int8Array(FILL_STACK_INITIAL);
  private n = 0;

  get size(): number { return this.n; }

  push(x0: number, x1: number, y: number, dir: number): void {
    if (this.n === this.xs.length) this.grow();
    this.xs[this.n] = x0; this.xe[this.n] = x1;
    this.ys[this.n] = y;  this.dy[this.n] = dir;
    this.n++;
  }

  pop(): { x0: number; x1: number; y: number; dir: number } | null {
    if (this.n === 0) return null;
    this.n--;
    return { x0: this.xs[this.n], x1: this.xe[this.n], y: this.ys[this.n], dir: this.dy[this.n] };
  }

  private grow(): void {
    const cap = this.xs.length * 2;
    const gx = new Int32Array(cap); gx.set(this.xs); this.xs = gx;
    const ge = new Int32Array(cap); ge.set(this.xe); this.xe = ge;
    const gy = new Int32Array(cap); gy.set(this.ys); this.ys = gy;
    const gd = new Int8Array(cap);  gd.set(this.dy); this.dy = gd;
  }
}

/** Straight (un-premultiplied) RGBA sampler over the match buffer. */
function makeSampler(
  surface: RasterSurface,
  sampleFrom?: Uint8ClampedArray
): (x: number, y: number, out: Float64Array) => void {
  if (sampleFrom) {
    const w = surface.width;
    return (x, y, out) => {
      const p = (y * w + x) * 4;
      out[0] = sampleFrom[p] / 255;
      out[1] = sampleFrom[p + 1] / 255;
      out[2] = sampleFrom[p + 2] / 255;
      out[3] = sampleFrom[p + 3] / 255;
    };
  }
  return (x, y, out) => {
    const i = surface.index(x, y);
    const a = surface.data[i + 3];
    // Matching must compare STRAIGHT colours: two pixels of the same hue at
    // different alphas are premultiplied to different values, and comparing
    // those would refuse to fill across an antialiased edge.
    if (a <= 0) { out[0] = out[1] = out[2] = out[3] = 0; return; }
    const inv = 1 / a;
    out[0] = surface.data[i] * inv;
    out[1] = surface.data[i + 1] * inv;
    out[2] = surface.data[i + 2] * inv;
    out[3] = a;
  };
}

/**
 * Compute the region a flood fill would affect, as a coverage buffer.
 *
 * Separated from the fill itself so the same region can be previewed,
 * feathered, grown, or used to erase instead of paint.
 */
export function floodFillRegion(
  surface: RasterSurface,
  settings: FloodFillSettings
): { coverage: CoverageBuffer; pixelsFilled: number; bounds: Rect } {
  const w = surface.width, h = surface.height;
  const coverage = surface.createCoverage();

  const sx = Math.floor(settings.seed.x);
  const sy = Math.floor(settings.seed.y);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
    return { coverage, pixelsFilled: 0, bounds: RECT_EMPTY };
  }

  const sample = makeSampler(surface, settings.sampleFrom);
  const target = new Float64Array(4);
  const probe = new Float64Array(4);
  sample(sx, sy, target);

  const tol = clamp(settings.tolerance, 0, 1);
  const matches = (x: number, y: number): boolean => {
    sample(x, y, probe);
    if (tol <= 0) {
      return probe[0] === target[0] && probe[1] === target[1] &&
             probe[2] === target[2] && probe[3] === target[3];
    }
    return colorDistance(
      probe[0], probe[1], probe[2], probe[3],
      target[0], target[1], target[2], target[3],
      FILL_WEIGHT_R, FILL_WEIGHT_G, FILL_WEIGHT_B, FILL_WEIGHT_A
    ) <= tol;
  };

  let filled = 0;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  const mark = (x: number, y: number): void => {
    coverage.data[y * w + x] = 1;
    filled++;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  /* ---- global (non-contiguous) mode ---- */
  if (!settings.contiguous) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (matches(x, y)) mark(x, y);
      }
    }
  } else {
    /* ---- span fill ---- */
    const visited = new Uint8Array(w * h);
    const stack = new SpanStack();
    let spans = 0;

    // A span record is (x0..x1 inclusive, y, direction it came from). Seeding
    // with dir 0 lets the first row expand both up and down.
    stack.push(sx, sx, sy, 0);

    while (stack.size > 0) {
      if (++spans > FILL_MAX_SPANS) break; // hard guard, cannot lock the tab
      const s = stack.pop();
      if (!s) break;
      const y = s.y;
      if (y < 0 || y >= h) continue;

      const row = y * w;

      // Walk left from the seed span, then right — fixed order ⇒ determinism.
      let x0 = s.x0;
      while (x0 > 0 && !visited[row + x0 - 1] && matches(x0 - 1, y)) x0--;
      let x1 = s.x1;
      while (x1 < w - 1 && !visited[row + x1 + 1] && matches(x1 + 1, y)) x1++;

      // Fill the run and mark it visited in one pass.
      for (let x = x0; x <= x1; x++) {
        if (visited[row + x]) continue;
        if (!matches(x, y)) continue;
        visited[row + x] = 1;
        mark(x, y);
      }

      // 8-connectivity extends the probe range by one pixel on each side,
      // which is what lets a fill escape through a single-pixel diagonal gap.
      const ext = settings.connectivity === 8 ? 1 : 0;
      const px0 = Math.max(0, x0 - ext);
      const px1 = Math.min(w - 1, x1 + ext);

      for (const dir of [-1, 1] as const) {
        const ny = y + dir;
        if (ny < 0 || ny >= h) continue;
        // Skip the row we came from unless this is the seed span, so each row
        // is scanned once rather than ping-ponging.
        if (s.dir !== 0 && dir === -s.dir) {
          // Still need the portions that extend BEYOND the parent span, or
          // the fill leaks past concave boundaries.
          pushRuns(stack, ny, px0, Math.min(px1, s.x0 - 1), dir, visited, w, matches);
          pushRuns(stack, ny, Math.max(px0, s.x1 + 1), px1, dir, visited, w, matches);
          continue;
        }
        pushRuns(stack, ny, px0, px1, dir, visited, w, matches);
      }
    }
  }

  if (maxX < 0) return { coverage, pixelsFilled: 0, bounds: RECT_EMPTY };

  const bounds = rect(minX, minY, maxX - minX + 1, maxY - minY + 1);
  coverage.dirty.addRect(bounds);

  // Grow BEFORE feather: dilating a feathered edge re-hardens it, whereas
  // feathering a dilated edge produces the soft boundary the user asked for.
  if (settings.grow > 0) coverage.dilate(clamp(settings.grow, 0, MAX_FILL_GROW));
  if (settings.feather > 0) coverage.feather(clamp(settings.feather, 0, MAX_FILL_FEATHER));

  return { coverage, pixelsFilled: filled, bounds: coverage.integerBounds() };
}

/** Find maximal matching runs in a row and push them as spans. */
function pushRuns(
  stack: SpanStack,
  y: number,
  from: number,
  to: number,
  dir: number,
  visited: Uint8Array,
  w: number,
  matches: (x: number, y: number) => boolean
): void {
  const row = y * w;
  let x = from;
  while (x <= to) {
    if (visited[row + x] || !matches(x, y)) { x++; continue; }
    const start = x;
    while (x <= to && !visited[row + x] && matches(x, y)) x++;
    stack.push(start, x - 1, y, dir);
  }
}

/** Fill, and composite the colour. */
export function floodFill(
  surface: RasterSurface,
  settings: FloodFillSettings
): FloodFillResult {
  const { coverage, pixelsFilled, bounds } = floodFillRegion(surface, settings);
  if (pixelsFilled === 0) return { pixelsFilled: 0, bounds: RECT_EMPTY };

  surface.compositeCoverage(
    coverage, settings.color, settings.opacity, settings.blend, bounds
  );
  return { pixelsFilled, bounds };
}

/** Erase within the flooded region — the "magic eraser". */
export function floodErase(
  surface: RasterSurface,
  settings: FloodFillSettings
): FloodFillResult {
  const { coverage, pixelsFilled, bounds } = floodFillRegion(surface, settings);
  if (pixelsFilled === 0) return { pixelsFilled: 0, bounds: RECT_EMPTY };
  surface.eraseCoverage(coverage, settings.opacity, bounds);
  return { pixelsFilled, bounds };
}

/** Fill the whole surface — no seed, no tolerance. */
export function fillAll(
  surface: RasterSurface,
  settings: Pick<FloodFillSettings, "color" | "opacity" | "blend">
): FloodFillResult {
  const cov = surface.createCoverage();
  cov.data.fill(1);
  cov.dirty.add(0, 0, surface.width, surface.height);
  surface.compositeCoverage(cov, settings.color, settings.opacity, settings.blend);
  return {
    pixelsFilled: surface.width * surface.height,
    bounds: rect(0, 0, surface.width, surface.height),
  };
}
