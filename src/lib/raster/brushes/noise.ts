/**
 * Deterministic, non-tiling noise.
 *
 * Everything here is a pure function of integer lattice coordinates and a seed,
 * built on a 32-bit integer hash. Three consequences matter for a brush:
 *
 *  - No `Math.random`: the same stroke replays to the same pixels, so undo,
 *    redo and the stabilizer's content hash are unaffected by texture.
 *  - No stored tile: the lattice is the whole (2³²)² integer plane, so there is
 *    no repeat period to spot, however long a stroke runs.
 *  - Coordinates are absolute (layer pixels), so a texture stays attached to
 *    the canvas: the second pass over a spot lands in the same paper tooth as
 *    the first.
 */

/** 32-bit integer hash of a lattice point (a murmur3-style finalizer). */
export function hash2(ix: number, iy: number, seed: number): number {
  let h =
    (Math.imul(ix | 0, 0x27d4eb2d) ^
      Math.imul(iy | 0, 0x165667b1) ^
      Math.imul(seed | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash → [0, 1). */
export const hash01 = (ix: number, iy: number, seed: number): number =>
  hash2(ix, iy, seed) / 4294967296;

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/* unit gradient directions, one per hash bucket — continuous angles, not the
 * 8 compass points of classic Perlin, which is what makes grain look "gridded" */
const GRAD_N = 256;
const GRAD_X = new Float32Array(GRAD_N);
const GRAD_Y = new Float32Array(GRAD_N);
for (let i = 0; i < GRAD_N; i++) {
  const a = (i / GRAD_N) * Math.PI * 2;
  GRAD_X[i] = Math.cos(a);
  GRAD_Y[i] = Math.sin(a);
}

/** 2D gradient noise, roughly in [-1, 1], zero-mean. */
export function gradNoise2(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;

  const g00 = hash2(x0, y0, seed) & 255;
  const g10 = hash2(x0 + 1, y0, seed) & 255;
  const g01 = hash2(x0, y0 + 1, seed) & 255;
  const g11 = hash2(x0 + 1, y0 + 1, seed) & 255;

  const n00 = GRAD_X[g00] * fx + GRAD_Y[g00] * fy;
  const n10 = GRAD_X[g10] * (fx - 1) + GRAD_Y[g10] * fy;
  const n01 = GRAD_X[g01] * fx + GRAD_Y[g01] * (fy - 1);
  const n11 = GRAD_X[g11] * (fx - 1) + GRAD_Y[g11] * (fy - 1);

  const u = fade(fx), v = fade(fy);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  // unit gradients peak near ±0.7 in 2D; 1.41 brings it close to ±1
  return (nx0 + (nx1 - nx0) * v) * 1.41;
}

/** 1D value noise in [0, 1]. Smooth (quintic), used for streaks along a stroke. */
export function valueNoise1(x: number, seed: number): number {
  const x0 = Math.floor(x);
  const t = fade(x - x0);
  const a = hash01(x0, 0, seed), b = hash01(x0 + 1, 0, seed);
  return a + (b - a) * t;
}

/** 2D value noise in [0, 1]. */
export function valueNoise2(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const u = fade(x - x0), v = fade(y - y0);
  const a = hash01(x0, y0, seed), b = hash01(x0 + 1, y0, seed);
  const c = hash01(x0, y0 + 1, seed), d = hash01(x0 + 1, y0 + 1, seed);
  const top = a + (b - a) * u;
  return top + (c + (d - c) * u - top) * v;
}

const ROT_C = Math.cos(0.5236 * 1.7), ROT_S = Math.sin(0.5236 * 1.7);

/**
 * Fractal gradient noise, roughly [-1, 1].
 *
 * Each octave is rotated and offset relative to the last. Without that the
 * octaves share one lattice, their zero-crossings line up on the axes, and the
 * result shows faint horizontal/vertical banding.
 */
export function fbm2(
  x: number, y: number, seed: number,
  octaves = 3, gain = 0.5, lacunarity = 2
): number {
  let sum = 0, amp = 1, norm = 0;
  let px = x, py = y;
  for (let o = 0; o < octaves; o++) {
    sum += amp * gradNoise2(px, py, seed + o * 1013);
    norm += amp;
    amp *= gain;
    const rx = (px * ROT_C - py * ROT_S) * lacunarity + 17.31;
    const ry = (px * ROT_S + py * ROT_C) * lacunarity - 9.77;
    px = rx; py = ry;
  }
  return sum / norm;
}
