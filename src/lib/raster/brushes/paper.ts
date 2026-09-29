/**
 * Paper — the surface a brush works on.
 *
 * A paper is a fixed HEIGHT FIELD over the canvas: tooth(x, y) ∈ [0, 1], where 1
 * is the top of a peak and 0 the bottom of a valley. It is a property of the
 * canvas, not of a stroke, and that is what makes texture behave physically:
 *
 *  - It never tiles. It is a pure function of absolute layer coordinates over
 *    the whole integer plane (see noise.ts), so there is no repeat to find.
 *  - It is continuous along a stroke, because the stroke only ever samples it.
 *  - It is shared between strokes. A second pass lands in the same tooth as the
 *    first, so graphite builds up on the same peaks rather than in a fresh
 *    random pattern each time.
 *
 * Fields are evaluated lazily and cached per pixel: only pixels a brush has
 * actually reached are ever computed, and only once.
 */

import { fbm2, gradNoise2, hash01 } from "./noise";

export type PaperKind = "graphite" | "charcoal" | "canvas" | "paper" | "coldpress";

/** Map a roughly ±1 noise value onto [0, 1] with a smooth, near-uniform spread,
 *  so a contact threshold sweeps through the tooth evenly as pressure rises. */
const equalize = (n: number, gain: number): number => 0.5 + 0.5 * Math.tanh(gain * n);

function tooth(kind: PaperKind, x: number, y: number): number {
  switch (kind) {
    case "graphite": {
      // fine, isotropic tooth
      const n = fbm2(x * 0.5 + 113.7, y * 0.5 - 41.3, 11, 3, 0.55);
      const speck = gradNoise2(x * 1.25, y * 1.25, 12) * 0.15;
      return equalize(n + speck, 1.7);
    }
    case "charcoal": {
      // coarse, high-contrast tooth with sparse deep pits
      const n = fbm2(x * 0.3 + 7.1, y * 0.3 + 21.9, 23, 3, 0.62);
      const speck = gradNoise2(x * 0.95, y * 0.95, 24) * 0.42;
      return equalize(n * 0.9 + speck, 2.5);
    }
    case "canvas": {
      // a woven cloth: two thread systems, warped and slubbed so no two cells
      // are alike and the weave never locks into a tile
      const P = 3.1;
      const wx = x + 2.4 * gradNoise2(x * 0.045, y * 0.045, 31);
      const wy = y + 2.4 * gradNoise2(x * 0.045 + 50, y * 0.045, 32);
      const ci = Math.floor(wx / P), cj = Math.floor(wy / P);
      const fx = wx / P - ci, fy = wy / P - cj;
      // thread profiles: round in cross-section, thicker where a slub sits
      const slubV = 0.75 + 0.5 * hash01(ci, 0, 33);
      const slubH = 0.75 + 0.5 * hash01(0, cj, 34);
      const tv = Math.sin(Math.PI * fx) * slubV;
      const th = Math.sin(Math.PI * fy) * slubH;
      const over = ((ci + cj) & 1) === 0;
      const weave = over ? tv * 0.85 + th * 0.15 : th * 0.85 + tv * 0.15;
      const fine = fbm2(x * 0.9, y * 0.9, 35, 2, 0.5) * 0.18;
      return Math.min(1, Math.max(0, 0.18 + 0.72 * weave + fine));
    }
    case "paper": {
      // soft medium grain with faint long fibres
      const n = fbm2(x * 0.4 + 3.3, y * 0.4 - 9.1, 41, 3, 0.5);
      const fibre = gradNoise2(x * 0.12 + y * 0.04, y * 0.7 - x * 0.04, 42) * 0.3;
      return equalize(n * 0.85 + fibre, 1.8);
    }
    case "coldpress":
    default: {
      // cold-press watercolour paper: broad rounded bumps and wide valleys, with
      // a finer tooth riding on them. Coarse enough that pigment collecting in
      // the valleys mottles a wash in patches instead of speckling it.
      const n = fbm2(x * 0.2 + 61.2, y * 0.2 + 17.7, 51, 3, 0.5);
      const fine = gradNoise2(x * 0.7, y * 0.7, 52) * 0.14;
      return equalize(n * 0.9 + fine, 1.6);
    }
  }
}

export class PaperField {
  readonly kind: PaperKind;
  readonly width: number;
  readonly height: number;
  /** tooth height per pixel; valid only where `known` is set. */
  readonly data: Float32Array;
  private readonly known: Uint8Array;

  constructor(kind: PaperKind, width: number, height: number) {
    this.kind = kind;
    this.width = width;
    this.height = height;
    this.data = new Float32Array(width * height);
    this.known = new Uint8Array(width * height);
  }

  /** Make sure every pixel in [x0,x1)×[y0,y1) has been evaluated. */
  fill(x0: number, y0: number, x1: number, y1: number): void {
    const w = this.width;
    const ax = Math.max(0, x0), ay = Math.max(0, y0);
    const bx = Math.min(w, x1), by = Math.min(this.height, y1);
    for (let y = ay; y < by; y++) {
      let i = y * w + ax;
      for (let x = ax; x < bx; x++, i++) {
        if (this.known[i]) continue;
        this.data[i] = tooth(this.kind, x + 0.5, y + 0.5);
        this.known[i] = 1;
      }
    }
  }

  /** Single sample. Prefer `fill` + `data` in hot loops. */
  at(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0.5;
    const i = y * this.width + x;
    if (!this.known[i]) {
      this.data[i] = tooth(this.kind, x + 0.5, y + 0.5);
      this.known[i] = 1;
    }
    return this.data[i];
  }
}

/* A small cache: the same paper is reused by every stroke on a surface of the
 * same size, so its cost is paid once per pixel, ever. */
const CACHE_LIMIT = 6;
const cache = new Map<string, PaperField>();

export function paperField(kind: PaperKind, width: number, height: number): PaperField {
  const key = `${kind}:${width}x${height}`;
  let f = cache.get(key);
  if (f) {
    cache.delete(key); // refresh recency
  } else {
    f = new PaperField(kind, width, height);
    if (cache.size >= CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  cache.set(key, f);
  return f;
}
