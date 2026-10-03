/**
 * Sub-pixel coverage store — the union buffer behind the hard brush.
 *
 * WHY A UNION NEEDS SUB-SAMPLES. A stroke is the union of many small pieces
 * (one per span of the curve). Merging their per-PIXEL coverage with `max` is
 * wrong whenever two pieces cover different parts of the same pixel: a thin
 * line crossing a pixel boundary at a joint comes out too light (each piece
 * covers half), and the usual cure — pretending every piece runs on forever —
 * makes ends blunt and joints beaded instead. Adding coverage is wrong the
 * other way, double-counting where pieces overlap.
 *
 * Splitting each pixel into S×S cells and taking `max` PER CELL makes the
 * union right to within a cell, and each cell's own coverage is still computed
 * analytically (exact area, never a 0/1 test), so movement stays continuous at
 * any sub-pixel offset. Only pixels on the anti-aliased rim are ever split: a
 * pixel entirely inside or outside the stroke stays one number, which is what
 * keeps a 24 px brush as cheap as a hairline.
 *
 * Storage is sparse: cells live in 16×16-pixel tiles allocated on first use, so
 * memory follows the length of the stroke's rim, not the size of the layer. A
 * one-byte flag per pixel says whether it is split, so the common case (a
 * pixel that is one number) costs a single read.
 */

/** Cells per pixel edge. 4×4 brings union and end-cap error below 1/255. */
export const SUB = 4;
export const SUB2 = SUB * SUB;
/** Edge of one cell, px. */
export const CELL = 1 / SUB;

const TILE_SHIFT = 4;
const TILE = 1 << TILE_SHIFT;
const TILE_MASK = TILE - 1;

export class SubpixelCoverage {
  readonly width: number;
  readonly height: number;
  /** Final per-pixel value: the mean of the pixel's cells (or its uniform value). */
  readonly value: Float32Array;

  /** 1 where the pixel holds cells; `value` alone is the pixel elsewhere. */
  readonly split: Uint8Array;

  private readonly tilesX: number;
  private readonly tiles: (Float32Array | null)[];
  /** The tile buffer `cells()` last resolved; offsets it returns index into it. */
  buf: Float32Array = new Float32Array(0);

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.value = new Float32Array(width * height);
    this.split = new Uint8Array(width * height);
    this.tilesX = Math.ceil(width / TILE);
    this.tiles = new Array(this.tilesX * Math.ceil(height / TILE)).fill(null);
  }

  private tileOf(x: number, y: number): number {
    return (y >> TILE_SHIFT) * this.tilesX + (x >> TILE_SHIFT);
  }

  private localOf(x: number, y: number): number {
    return ((y & TILE_MASK) << TILE_SHIFT) | (x & TILE_MASK);
  }

  /** The smallest cell value of a pixel: nothing below it can raise the pixel. */
  floor(x: number, y: number): number {
    const i = y * this.width + x;
    if (this.split[i] === 0) return this.value[i];
    const off = this.cells(x, y);
    const b = this.buf;
    let m = b[off];
    for (let k = 1; k < SUB2; k++) if (b[off + k] < m) m = b[off + k];
    return m;
  }

  /** A pixel the shape covers entirely: every cell rises to at least `v`. */
  solid(x: number, y: number, v: number): void {
    const i = y * this.width + x;
    if (this.split[i] === 0) {
      if (v > this.value[i]) this.value[i] = v;
      return;
    }
    const off = this.cells(x, y);
    const b = this.buf;
    for (let k = 0; k < SUB2; k++) if (v > b[off + k]) b[off + k] = v;
    this.resolve(x, y, off);
  }

  /**
   * Offset of the pixel's SUB2 cells in `this.buf` (row-major, cell (i, j) at
   * off + j·SUB + i), splitting the pixel first if it was uniform.
   */
  cells(x: number, y: number): number {
    const t = this.tileOf(x, y);
    let buf = this.tiles[t];
    if (!buf) {
      buf = new Float32Array(TILE * TILE * SUB2);
      this.tiles[t] = buf;
    }
    const off = this.localOf(x, y) * SUB2;
    const i = y * this.width + x;
    if (this.split[i] === 0) {
      this.split[i] = 1;
      buf.fill(this.value[i], off, off + SUB2);
    }
    this.buf = buf;
    return off;
  }

  /** Recompute a split pixel's value from its cells (after editing them). */
  resolve(x: number, y: number, off: number): void {
    const b = this.buf;
    let s = 0;
    for (let k = 0; k < SUB2; k++) s += b[off + k];
    this.value[y * this.width + x] = s / SUB2;
  }

  /** Forget everything inside [x0, x1) × [y0, y1). */
  clear(x0: number, y0: number, x1: number, y1: number): void {
    for (let y = y0; y < y1; y++) {
      this.value.fill(0, y * this.width + x0, y * this.width + x1);
      this.split.fill(0, y * this.width + x0, y * this.width + x1);
    }
  }
}
