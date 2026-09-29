/**
 * Procedural paper — no image textures.
 *
 * `paperTooth(x, y, seed, lod)` returns the height of the paper surface at a
 * point in layer space, 0 (valley) … 1 (peak). It is a pure, continuous
 * function of position, so it can be sampled at any zoom: zooming in shows
 * the same tooth larger, never a stretched bitmap.
 *
 * Built from four layers, as a cold-press sheet is:
 *   1. fiber direction field — slow Perlin field steering elongated fibers;
 *   2. micro tooth           — two octaves of Voronoi cells: plateaus
 *                              with pits, each cell at its own height;
 *   3. cotton compression    — low-frequency patches where the sheet was
 *                              pressed flatter and takes graphite more evenly;
 *   4. absorption            — applied by the renderer: graphite only reaches
 *                              valleys as deep as pressure and dwell allow.
 *
 * Every sheet has its own seed. The output is deterministic for a given seed,
 * which matters: the flattened frame feeds the stabilizer's content hash.
 */

/* ---------------- hashing ---------------- */

function hash(ix: number, iy: number, seed: number): number {
  let h = seed ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/* ---------------- gradient (Perlin) noise ---------------- */

const GX = [1, -1, 1, -1, 1.4142, -1.4142, 0, 0];
const GY = [1, 1, -1, -1, 0, 0, 1.4142, -1.4142];

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Perlin gradient noise, roughly −1…1. */
function perlin(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const g00 = hash(x0, y0, seed) & 7;
  const g10 = hash(x0 + 1, y0, seed) & 7;
  const g01 = hash(x0, y0 + 1, seed) & 7;
  const g11 = hash(x0 + 1, y0 + 1, seed) & 7;
  const n00 = GX[g00] * fx + GY[g00] * fy;
  const n10 = GX[g10] * (fx - 1) + GY[g10] * fy;
  const n01 = GX[g01] * fx + GY[g01] * (fy - 1);
  const n11 = GX[g11] * (fx - 1) + GY[g11] * (fy - 1);
  const u = fade(fx);
  const v = fade(fy);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 0.9;
}

/* ---------------- cellular (Voronoi) noise ---------------- */

/** Random 0..1 height of the cell that won the last `voronoi` call. */
let lastCell = 0;

/** Distance to the nearest feature point (F1), in cell units. */
function voronoi(x: number, y: number, seed: number): number {
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  let best = 8;
  let bestHash = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const h = hash(cx + i, cy + j, seed);
      const px = cx + i + 0.1 + 0.8 * ((h & 0xffff) / 0xffff);
      const py = cy + j + 0.1 + 0.8 * ((h >>> 16) / 0xffff);
      const dx = px - x;
      const dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        bestHash = h;
      }
    }
  }
  lastCell = ((bestHash >>> 8) & 0xff) / 255;
  return Math.sqrt(best);
}

/** Cold-press tooth: broad rounded plateaus with a pit at each feature
 *  point, each cell at its own height so the pattern never looks regular. */
function toothCell(f1: number): number {
  const t = Math.min(1, Math.max(0, (f1 - 0.06) / 0.56));
  return t * t * (3 - 2 * t) * (0.7 + 0.3 * lastCell);
}

/* ---------------- the sheet ---------------- */

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Scales in layer px — the sheet's physical grain size.
const FIBER_FIELD = 170;
const FIBER_LEN = 11;
const FIBER_WIDTH = 3.2;
const TOOTH_COARSE = 2.4;
const TOOTH_FINE = 1.05;
const COMPRESSION = 38;

const COS_A = Math.cos(0.35);
const SIN_A = Math.sin(0.35);

/** Mean cell height, so faded octaves are replaced by their average. */
const CELL_MEAN = (() => {
  let sum = 0;
  const n = 64;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) sum += toothCell(voronoi(i * 0.37 + 0.1, j * 0.41 + 0.2, 1));
  }
  return sum / (n * n);
})();

/**
 * Paper height at a layer-space point.
 *
 * `lod` = layer px covered by one output pixel. Detail finer than a pixel is
 * faded to its mean instead of being point-sampled, so a zoomed-out view shows
 * even tone rather than aliasing shimmer.
 */
export function paperTooth(x: number, y: number, seed: number, lod: number): number {
  // 1. Fiber direction field: fibers run mostly one way, turning slowly.
  const turn = perlin(x / FIBER_FIELD, y / FIBER_FIELD, seed ^ 0x51ed27);
  const w = 0.5 + 0.5 * Math.cos(turn * Math.PI * 2);
  const u1 = x * COS_A + y * SIN_A;
  const v1 = -x * SIN_A + y * COS_A;
  const fa = perlin(u1 / FIBER_LEN, v1 / FIBER_WIDTH, seed ^ 0x3c6ef3);
  const fb = perlin(v1 / FIBER_LEN, u1 / FIBER_WIDTH, seed ^ 0x6a09e6);
  const fiberDetail = 1 - smoothstep(1.5, 4, lod);
  const fiber = 0.5 + 0.5 * (w * fa + (1 - w) * fb) * fiberDetail;

  // 2. Micro tooth: coarse and fine Voronoi cells.
  const coarseDetail = 1 - smoothstep(1, 2.8, lod);
  const fineDetail = 1 - smoothstep(0.4, 1.2, lod);
  const coarse =
    coarseDetail > 0
      ? CELL_MEAN + (toothCell(voronoi(x / TOOTH_COARSE, y / TOOTH_COARSE, seed ^ 0x9e3779)) - CELL_MEAN) * coarseDetail
      : CELL_MEAN;
  const fine =
    fineDetail > 0
      ? CELL_MEAN + (toothCell(voronoi(x / TOOTH_FINE, y / TOOTH_FINE, seed ^ 0xbb67ae)) - CELL_MEAN) * fineDetail
      : CELL_MEAN;

  let tooth = 0.62 * coarse + 0.26 * fine + 0.12 * fiber;

  // 3. Cotton compression: pressed patches are flatter.
  const c =
    0.5 +
    0.35 * perlin(x / COMPRESSION, y / COMPRESSION, seed ^ 0xa54ff5) +
    0.15 * perlin(x / (COMPRESSION / 3), y / (COMPRESSION / 3), seed ^ 0x510e52);
  const flat = 0.45 * smoothstep(0.45, 0.9, c);
  tooth = tooth * (1 - flat) + 0.5 * flat;

  return Math.min(1, Math.max(0, tooth * 1.25 - 0.05));
}
