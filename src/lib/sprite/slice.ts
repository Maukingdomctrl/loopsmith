/**
 * Loop Sprite Engine — exact sheet slicing.
 *
 * This module is deliberately dumb. Every decision about *where* the cuts go
 * was made by the detector and frozen into `SpriteGrid.cutsX` / `cutsY`; the
 * slicer's only job is to move pixels without changing them.
 *
 * Three invariants are enforced here, and they are the whole point of the file:
 *
 *   1. NO RESAMPLING. Extraction is a row-wise `TypedArray.set` from the source
 *      `ImageData` into a destination of exactly the cut-implied size. There is
 *      no `drawImage` scaling path, no `imageSmoothingQuality`, no fractional
 *      source rectangle. A frame's pixels are bit-identical to the source's.
 *
 *   2. NO ORIENTATION DRIFT. The decoder is pinned to `imageOrientation:"none"`
 *      so the pixel lattice the slicer sees is the same lattice the detector
 *      measured. If a JPEG carries an EXIF rotation and the decoder silently
 *      applied it, every cut would land in the wrong place — and the output
 *      would look *almost* right, which is the worst possible failure mode.
 *
 *   3. NO SILENT COORDINATE COERCION. A grid that does not fit the decoded
 *      image is a programming error (usually: the grid was detected on a
 *      downscaled preview). We throw `SliceError("grid-mismatch")` rather than
 *      clamping, because clamping produces plausible-looking garbage.
 *
 * Known, accepted limitation: encoding a frame requires a canvas round-trip,
 * and canvas backing stores are premultiplied. Colour channels of pixels with
 * very low alpha may therefore quantise on the way out. Callers that need
 * mathematically exact RGBA (atlas re-packers, diff tools) should use
 * `sliceImageData` and consume `slice.pixels` directly, skipping `blob`/`url`.
 */

import {
  DEFAULT_SPRITE_CONFIG,
  type CellRect,
  type OccupancyKind,
  type SpriteEngineConfig,
  type SpriteGrid,
} from "./types";
import { buildOccupancy } from "./occupancy";
import {
  buildOwnershipReport,
  groupUnits,
  labelComponents,
} from "./ownership";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * One extracted frame.
 *
 * `index` is the row-major scan-order position and is ALWAYS the untrimmed
 * index, even when empty frames have been filtered out. Callers that build
 * animation timelines can therefore rely on `index` as a stable identity that
 * survives a change to `trimTrailingEmpty`.
 */
export interface SpriteSlice {
  readonly index: number;
  readonly col: number;
  readonly row: number;
  /** Source rectangle in original image space. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Raw extracted pixels. Always present; never resampled. */
  readonly pixels: ImageData;
  /** Encoded frame. Null when `options.encode` is false. */
  readonly blob: Blob | null;
  /** Object URL for `blob`. Null unless `options.createUrls` is true. */
  readonly url: string | null;
  /** Deterministic filename, e.g. `frame_003.png`. */
  readonly name: string;
  /** True when the frame carries no ink (see `classifyFrame`). */
  readonly empty: boolean;
  /** Σ alpha over the frame, in raw 8-bit units. Cheap ordering signal. */
  readonly alphaMass: number;
}

export interface SliceSheetResult {
  readonly slices: readonly SpriteSlice[];
  readonly grid: SpriteGrid;
  /** cols·rows — the number of cells the grid defines. */
  readonly cellCount: number;
  /** Frames actually returned after empty-filtering. */
  readonly frameCount: number;
  /** Frames dropped as empty. */
  readonly emptyCount: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** Pixels discarded by symmetric remainder cropping, on each axis. */
  readonly croppedX: number;
  readonly croppedY: number;
  readonly mimeType: string;
}

export type SliceErrorCode =
  | "decode-failed" // the browser could not decode the file at all
  | "too-large" // pixel count exceeded the configured guard
  | "invalid-grid" // cuts are malformed: wrong length, non-increasing, negative
  | "grid-mismatch" // cuts fall outside the decoded image
  | "frame-budget" // cols·rows exceeded `maxFrames`
  | "encode-failed" // canvas refused to produce a blob
  | "no-canvas" // no 2D rendering context available in this environment
  | "aborted"; // caller signalled cancellation

export class SliceError extends Error {
  readonly code: SliceErrorCode;
  readonly detail: string;

  constructor(code: SliceErrorCode, detail = "") {
    super(detail === "" ? code : `${code}: ${detail}`);
    this.name = "SliceError";
    this.code = code;
    this.detail = detail;
  }
}

export interface SliceOptions {
  /** Produce `blob` for each frame. Disable for pure pixel access. */
  readonly encode: boolean;
  /** Produce `url` for each frame. Implies `encode`. Caller must revoke. */
  readonly createUrls: boolean;
  /** Encoder MIME type. PNG is the only lossless, alpha-preserving choice. */
  readonly mimeType: string;
  /** Lossy-encoder quality in [0,1]. Ignored for PNG. */
  readonly quality: number;
  /** Filename stem; the index and extension are appended. */
  readonly namePrefix: string;
  /**
   * Zero-padding width for the index in filenames. 0 selects the smallest
   * width that keeps every name the same length, so lexicographic order and
   * numeric order agree — which matters because most tools sort by name.
   */
  readonly padding: number;
  /** Drop empty frames that form a suffix of scan order (the usual ragged row). */
  readonly trimTrailingEmpty: boolean;
  /** Drop every empty frame, including interior holes. Off by default. */
  readonly dropEmpty: boolean;
  /** Hard ceiling on cols·rows, mirroring the detector's own budget. */
  readonly maxFrames: number;
  /** Hard ceiling on decoded pixels. */
  readonly maxPixels: number;
  /** Cooperative cancellation. Checked once per frame. */
  readonly signal: AbortSignal | null;
  /** Invoked after each frame with (completed, total). */
  readonly onProgress: ((completed: number, total: number) => void) | null;
}

export const DEFAULT_SLICE_OPTIONS: SliceOptions = {
  encode: true,
  createUrls: true,
  mimeType: "image/png",
  quality: 0.92,
  namePrefix: "frame_",
  padding: 0,
  trimTrailingEmpty: true,
  dropEmpty: false,
  maxFrames: DEFAULT_SPRITE_CONFIG.maxFrames,
  maxPixels: DEFAULT_SPRITE_CONFIG.maxPixels,
  signal: null,
  onProgress: null,
};

// ---------------------------------------------------------------------------
// Grid validation and cell enumeration
// ---------------------------------------------------------------------------

/**
 * Enumerate cells in row-major scan order.
 *
 * Reads ONLY the cut vectors, never `cellWidth`/`cellHeight`. That is what lets
 * irregular grids (variable frame sizes, when `allowIrregular` is enabled) flow
 * through the slicer with no special-casing: for a uniform grid the cut vectors
 * happen to be an arithmetic progression, and nothing downstream cares.
 */
export function enumerateCells(grid: SpriteGrid): CellRect[] {
  const cells: CellRect[] = [];
  for (let row = 0; row < grid.rows; row++) {
    const y = grid.cutsY[row];
    const height = grid.cutsY[row + 1] - y;
    for (let col = 0; col < grid.cols; col++) {
      const x = grid.cutsX[col];
      cells.push({
        index: row * grid.cols + col,
        col,
        row,
        x,
        y,
        width: grid.cutsX[col + 1] - x,
        height,
      });
    }
  }
  return cells;
}

function isPositiveInt(v: number): boolean {
  return Number.isInteger(v) && v > 0;
}

/**
 * Structural validation, independent of any image.
 *
 * Separated from `assertGridFits` so callers can sanity-check a persisted or
 * hand-edited grid before they pay for a decode.
 */
export function validateGrid(grid: SpriteGrid): void {
  if (!isPositiveInt(grid.cols) || !isPositiveInt(grid.rows)) {
    throw new SliceError(
      "invalid-grid",
      `cols/rows must be positive integers, got ${grid.cols}x${grid.rows}`
    );
  }
  if (grid.cutsX.length !== grid.cols + 1) {
    throw new SliceError(
      "invalid-grid",
      `cutsX has ${grid.cutsX.length} entries, expected ${grid.cols + 1}`
    );
  }
  if (grid.cutsY.length !== grid.rows + 1) {
    throw new SliceError(
      "invalid-grid",
      `cutsY has ${grid.cutsY.length} entries, expected ${grid.rows + 1}`
    );
  }
  for (let i = 0; i < grid.cutsX.length; i++) {
    const v = grid.cutsX[i];
    if (!Number.isInteger(v) || v < 0) {
      throw new SliceError("invalid-grid", `cutsX[${i}] = ${v} is not a non-negative integer`);
    }
    if (i > 0 && v <= grid.cutsX[i - 1]) {
      throw new SliceError(
        "invalid-grid",
        `cutsX must strictly increase: cutsX[${i - 1}]=${grid.cutsX[i - 1]} >= cutsX[${i}]=${v}`
      );
    }
  }
  for (let i = 0; i < grid.cutsY.length; i++) {
    const v = grid.cutsY[i];
    if (!Number.isInteger(v) || v < 0) {
      throw new SliceError("invalid-grid", `cutsY[${i}] = ${v} is not a non-negative integer`);
    }
    if (i > 0 && v <= grid.cutsY[i - 1]) {
      throw new SliceError(
        "invalid-grid",
        `cutsY must strictly increase: cutsY[${i - 1}]=${grid.cutsY[i - 1]} >= cutsY[${i}]=${v}`
      );
    }
  }
}

/**
 * Check the grid against concrete image dimensions.
 *
 * We refuse rather than clamp. The dominant cause of a mismatch is a grid
 * detected on a downscaled preview and then applied to the full-resolution
 * file; clamping would emit frames that are subtly misaligned everywhere,
 * and the user would blame the detector.
 */
export function assertGridFits(grid: SpriteGrid, width: number, height: number): void {
  validateGrid(grid);
  const lastX = grid.cutsX[grid.cols];
  const lastY = grid.cutsY[grid.rows];
  if (lastX > width || lastY > height) {
    throw new SliceError(
      "grid-mismatch",
      `grid spans ${lastX}x${lastY} but image is ${width}x${height}; ` +
        `the grid was probably detected on a different-sized copy of this image`
    );
  }
}

// ---------------------------------------------------------------------------
// Canvas plumbing
// ---------------------------------------------------------------------------

interface Surface {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}

function createSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);

    const ctx = canvas.getContext("2d", {
      willReadFrequently: true,
    });

    if (!ctx) {
      throw new Error("Unable to create 2D canvas context.");
    }

    return { canvas, ctx };
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", {
    willReadFrequently: true,
  });

  if (!ctx) {
    throw new Error("Unable to create 2D canvas context.");
  }

  return { canvas, ctx };
}


export async function exportFrameUrls(
  slices: readonly SpriteSlice[]
): Promise<string[]> {
  const urls: string[] = [];

  for (let i = 0; i < slices.length; i++) {
    const frame = slices[i];
    const canvas = document.createElement("canvas");

    canvas.width = frame.width;
    canvas.height = frame.height;

    const ctx = canvas.getContext("2d", {
      willReadFrequently: true,
    });

    if (!ctx) {
      throw new Error("Unable to create 2D canvas context.");
    }

    ctx.putImageData(frame.pixels, 0, 0);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("PNG encoding failed."))),
        "image/png"
      );
    });

    urls.push(URL.createObjectURL(blob));
  }

  return urls;
}
/**
 * Revoke every object URL previously created by `exportFrameUrls`.
 *
 * Safe to call repeatedly; invalid URLs are ignored by the browser.
 */
export function revokeSliceUrls(urls: readonly string[]): void {
  for (let i = 0; i < urls.length; i++) {
    URL.revokeObjectURL(urls[i]);
  }
}

// Add this to the bottom of slice.ts

export async function decodeToImageData(
  source: Blob | ImageData | ImageBitmap,
  maxPixels: number
): Promise<ImageData> {
  if (source instanceof ImageData) {
    if (source.width * source.height > maxPixels) throw new SliceError("too-large");
    return source;
  }

  const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);

  if (bitmap.width * bitmap.height > maxPixels) {
    bitmap.close();
    throw new SliceError("too-large");
  }

  const { canvas, ctx } = createSurface(bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

  if (!(source instanceof ImageBitmap)) {
    bitmap.close(); // Clean up memory if we created the bitmap here
  }

  return imageData;
}

export function sliceImageData(
  image: ImageData,
  grid: SpriteGrid,
  options: SliceOptions
): SliceSheetResult {
  assertGridFits(grid, image.width, image.height);
  const cells = enumerateCells(grid);
  const slices: SpriteSlice[] = [];

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const dest = new ImageData(cell.width, cell.height);

    // Rule 1: NO RESAMPLING. Row-wise TypedArray.set extraction
    const sourceRowBytes = image.width * 4;
    const destRowBytes = cell.width * 4;
    for (let y = 0; y < cell.height; y++) {
      const srcOffset = ((cell.y + y) * image.width + cell.x) * 4;
      const destOffset = y * destRowBytes;
      dest.data.set(image.data.subarray(srcOffset, srcOffset + destRowBytes), destOffset);
    }

    slices.push({
      index: cell.index,
      col: cell.col,
      row: cell.row,
      x: cell.x,
      y: cell.y,
      width: cell.width,
      height: cell.height,
      pixels: dest,
      blob: null,
      url: null,
      name: `${options.namePrefix}${cell.index.toString().padStart(options.padding, "0")}.png`,
      empty: false,
      alphaMass: 0,
    });
  }

  return {
    slices,
    grid,
    cellCount: cells.length,
    frameCount: cells.length,
    emptyCount: 0,
    sourceWidth: image.width,
    sourceHeight: image.height,
    croppedX: 0,
    croppedY: 0,
    mimeType: options.mimeType,
  };
}

export async function sliceSheet(
  source: Blob | ImageData | ImageBitmap,
  grid: SpriteGrid,
  options: Partial<SliceOptions> = {}
): Promise<SliceSheetResult> {
  const opts = { ...DEFAULT_SLICE_OPTIONS, ...options };
  const image = await decodeToImageData(source, opts.maxPixels);
  const result = sliceImageData(image, grid, opts);

  if (!opts.encode) return result;

  const slices: SpriteSlice[] = [];
  for (let i = 0; i < result.slices.length; i++) {
    const slice = result.slices[i];
    const { canvas, ctx } = createSurface(slice.width, slice.height);
    ctx.putImageData(slice.pixels, 0, 0);

    let blob: Blob;
    if ("convertToBlob" in canvas) {
      blob = await (canvas as OffscreenCanvas).convertToBlob({ type: opts.mimeType });
    } else {
      blob = await new Promise<Blob>((resolve, reject) => {
        (canvas as HTMLCanvasElement).toBlob(
          (b) => (b ? resolve(b) : reject(new SliceError("encode-failed"))),
          opts.mimeType
        );
      });
    }

    slices.push({
      ...slice,
      blob,
      url: opts.createUrls ? URL.createObjectURL(blob) : null,
    });
  }

  return { ...result, slices };
}
// ---------------------------------------------------------------------------
// Clean extraction: each frame keeps only the sprite its cell owns
// ---------------------------------------------------------------------------

/**
 * Result of `extractCleanCells`.
 *
 * `cleaned` is false when the sheet has no separable background (a photo, or a
 * checkerboard painted into the pixels). Frames are then plain rectangle copies,
 * exactly what the old cutter produced, so the caller never gets worse output.
 */
export interface CleanCellsResult {
  /** One frame per cell, row-major, each exactly the cell's size. */
  readonly frames: ImageData[];
  readonly kind: OccupancyKind;
  readonly cleaned: boolean;
  /** Pixels recognised as drawn grid/box lines and removed. */
  readonly linePixels: number;
  /** Ink pixels removed because another cell owns them. */
  readonly foreignPixels: number;
}

/** Plain, bit-exact rectangle copy (the old behaviour). */
function copyCell(image: ImageData, cell: CellRect): ImageData {
  const dest = new ImageData(cell.width, cell.height);
  const rowBytes = cell.width * 4;
  for (let y = 0; y < cell.height; y++) {
    const src = ((cell.y + y) * image.width + cell.x) * 4;
    dest.data.set(image.data.subarray(src, src + rowBytes), y * rowBytes);
  }
  return dest;
}

function medianInt(values: number[]): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[(s.length - 1) >> 1];
}

/**
 * Mark pixels that belong to straight, thin, long lines: the grid lines and
 * boxes AI image tools draw around frames.
 *
 * A horizontal run of ink qualifies when it is at least `minLenX` long and at
 * least 85% of its pixels are thin vertically (≤ `thick` px). Only the thin
 * pixels are marked, so where a line passes through a sprite the sprite stays.
 * Vertical runs are treated symmetrically.
 */
function markLines(
  occ: Uint8Array,
  w: number,
  h: number,
  ink: number,
  minLenX: number,
  minLenY: number,
  thick: number,
  out: Uint8Array
): number {
  const n = w * h;
  const hRun = new Uint16Array(n);
  const vRun = new Uint16Array(n);

  for (let y = 0; y < h; y++) {
    const base = y * w;
    let x = 0;
    while (x < w) {
      if (occ[base + x] < ink) { x++; continue; }
      let e = x;
      while (e < w && occ[base + e] >= ink) e++;
      const len = Math.min(65535, e - x);
      for (let i = x; i < e; i++) hRun[base + i] = len;
      x = e;
    }
  }
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (occ[y * w + x] < ink) { y++; continue; }
      let e = y;
      while (e < h && occ[e * w + x] >= ink) e++;
      const len = Math.min(65535, e - y);
      for (let i = y; i < e; i++) vRun[i * w + x] = len;
      y = e;
    }
  }

  let marked = 0;

  // Horizontal lines.
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let x = 0;
    while (x < w) {
      const len = hRun[base + x];
      if (len === 0) { x++; continue; }
      if (len >= minLenX) {
        let thin = 0;
        for (let i = x; i < x + len; i++) if (vRun[base + i] <= thick) thin++;
        if (thin * 100 >= len * 85) {
          for (let i = x; i < x + len; i++) {
            const p = base + i;
            if (vRun[p] <= thick && !out[p]) { out[p] = 1; marked++; }
          }
        }
      }
      x += len;
    }
  }

  // Vertical lines.
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      const len = vRun[y * w + x];
      if (len === 0) { y++; continue; }
      if (len >= minLenY) {
        let thin = 0;
        for (let i = y; i < y + len; i++) if (hRun[i * w + x] <= thick) thin++;
        if (thin * 100 >= len * 85) {
          for (let i = y; i < y + len; i++) {
            const p = i * w + x;
            if (hRun[p] <= thick && !out[p]) { out[p] = 1; marked++; }
          }
        }
      }
      y += len;
    }
  }

  return marked;
}

/**
 * Cut every cell of `grid` out of `image`, keeping ONLY the sprite that cell
 * owns. Frame sizes are exactly the cell sizes, as before.
 *
 * Pipeline (all existing engine stages, now used at cut time):
 *   1. occupancy        → what is ink and what is background
 *   2. line removal     → drawn grid lines / boxes stop counting as ink
 *   3. components+units → which pixels form one sprite (crowns, sparkles attach)
 *   4. ownership        → which cell each sprite belongs to
 *   5. per cell: keep owned ink and anything it encloses (eyes, mouths);
 *      everything reachable from the cell border without crossing owned ink
 *      becomes transparent — neighbour pieces, lines, background, halos.
 *
 * On an opaque sheet (background colour, e.g. white) edge pixels are also
 * un-blended from the background colour, so a sprite cut from white does not
 * keep a white fringe when placed on a dark background.
 */
export function extractCleanCells(
  image: ImageData,
  grid: SpriteGrid,
  config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
): CleanCellsResult {
  assertGridFits(grid, image.width, image.height);
  const cells = enumerateCells(grid);
  const field = buildOccupancy(image, config);

  if (field.kind !== "alpha" && field.kind !== "background") {
    return {
      frames: cells.map((c) => copyCell(image, c)),
      kind: field.kind,
      cleaned: false,
      linePixels: 0,
      foreignPixels: 0,
    };
  }

  const W = image.width;
  const H = image.height;
  const src = image.data;
  const ink = Math.max(1, config.minInkLevel);

  // 1–2. Occupancy with drawn lines removed. Works on a copy.
  const occ = new Uint8Array(field.data);
  const isLine = new Uint8Array(W * H);
  const widths: number[] = [];
  const heights: number[] = [];
  for (let i = 0; i < grid.cols; i++) widths.push(grid.cutsX[i + 1] - grid.cutsX[i]);
  for (let i = 0; i < grid.rows; i++) heights.push(grid.cutsY[i + 1] - grid.cutsY[i]);
  const cellW = Math.max(8, medianInt(widths));
  const cellH = Math.max(8, medianInt(heights));
  const thick = Math.max(3, Math.round(Math.min(W, H) * 0.003));
  const linePixels = markLines(
    occ, W, H, ink,
    Math.max(24, Math.round(cellW * 0.85)),
    Math.max(24, Math.round(cellH * 0.85)),
    thick,
    isLine
  );
  if (linePixels > 0) {
    for (let p = 0; p < isLine.length; p++) if (isLine[p]) occ[p] = 0;
  }
  const cleanField = { ...field, data: occ };

  // 3–4. Sprite units and who owns them, for THIS grid.
  const labelling = labelComponents(cleanField, config);
  const grouping = groupUnits(labelling, config);
  const report = buildOwnershipReport(cleanField, grid, labelling, grouping, config);
  const ownerOfUnit = new Int32Array(report.units.length);
  for (let u = 0; u < report.units.length; u++) ownerOfUnit[u] = report.units[u].ownerCell;
  const labels = labelling.labels;
  const unitOf = grouping.unitOfComponent;

  const opaque = field.kind === "background";
  const bgR = opaque && field.background !== null ? (field.background >> 16) & 255 : 0;
  const bgG = opaque && field.background !== null ? (field.background >> 8) & 255 : 0;
  const bgB = opaque && field.background !== null ? field.background & 255 : 0;

  let foreignPixels = 0;
  const frames: ImageData[] = [];

  for (let ci = 0; ci < cells.length; ci++) {
    const cell = cells[ci];
    const cw = cell.width;
    const ch = cell.height;
    const count = cw * ch;
    const dest = copyCell(image, cell);
    const d = dest.data;
    
     // Edge band: small pieces touching it are neighbour leftovers, not this sprite.
    const margin = Math.max(6, Math.round(Math.min(cw, ch) * 0.06));
    let mainMass = 0;
    for (const u of report.units) if (u.ownerCell === cell.index && u.mass > mainMass) mainMass = u.mass;
    const dropUnit = new Uint8Array(report.units.length);
    for (let u = 0; u < report.units.length; u++) {
      const un = report.units[u];
      if (un.ownerCell !== cell.index || un.mass >= mainMass * 0.15) continue;
            dropUnit[u] = 1;
    }

    // Owned ink in this cell.
    const owned = new Uint8Array(count);
    for (let y = 0; y < ch; y++) {
      const gy = cell.y + y;
      for (let x = 0; x < cw; x++) {
        const gp = gy * W + cell.x + x;
        const l = labels[gp];
        if (l < 0) continue;
        const u = unitOf[l];
         if (u >= 0 && ownerOfUnit[u] === cell.index && !dropUnit[u]) owned[y * cw + x] = 1;
        else foreignPixels++;
      }
    }

    // Flood from the cell border through everything that is not owned ink.
    const outside = new Uint8Array(count);
    const stack = new Int32Array(count);
    let top = 0;
    const seed = (p: number) => {
      if (!owned[p] && !outside[p]) { outside[p] = 1; stack[top++] = p; }
    };
    for (let x = 0; x < cw; x++) { seed(x); seed((ch - 1) * cw + x); }
    for (let y = 0; y < ch; y++) { seed(y * cw); seed(y * cw + cw - 1); }
    while (top > 0) {
      const p = stack[--top];
      const y = (p / cw) | 0;
      const x = p - y * cw;
      if (x > 0) seed(p - 1);
      if (x < cw - 1) seed(p + 1);
      if (y > 0) seed(p - cw);
      if (y < ch - 1) seed(p + cw);
    }

    // Write alpha (and un-blend opaque-sheet edges).
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const p = y * cw + x;
        const i = p * 4;
        if (outside[p]) { d[i + 3] = 0; continue; }
        if (!opaque || !owned[p]) continue; // interior or alpha sheet: keep as is

        const onEdge =
          (x > 0 && outside[p - 1]) ||
          (x < cw - 1 && outside[p + 1]) ||
          (y > 0 && outside[p - cw]) ||
          (y < ch - 1 && outside[p + cw]);
        if (!onEdge) continue;

        const a = occ[(cell.y + y) * W + cell.x + x] / 255;
        if (a >= 0.999) continue;
        if (a < 0.1) { d[i + 3] = 0; continue; }
        const k = 1 - a;
        d[i] = Math.max(0, Math.min(255, Math.round((src[((cell.y + y) * W + cell.x + x) * 4] - k * bgR) / a)));
        d[i + 1] = Math.max(0, Math.min(255, Math.round((src[((cell.y + y) * W + cell.x + x) * 4 + 1] - k * bgG) / a)));
        d[i + 2] = Math.max(0, Math.min(255, Math.round((src[((cell.y + y) * W + cell.x + x) * 4 + 2] - k * bgB) / a)));
        d[i + 3] = Math.round(d[i + 3] * a);
      }
    }

    frames.push(dest);
  }

  return { frames, kind: field.kind, cleaned: true, linePixels, foreignPixels };
}