/**
 * LSA v1.0 — §B.1: the translation-equivariant signal.
 *
 * Owns four correctness conditions that the paper proves, not four options:
 *
 *  1. PREMULTIPLICATION (B.1). y_i = α_i · Rec709(RGB). Undefined colour under
 *     α = 0 (PNG encoders write garbage there) can then never enter. Blurring
 *     NON-premultiplied RGB is provably wrong: it mixes that garbage into
 *     visible pixels and manufactures halo gradients, i.e. pure bias.
 *  2. ZERO PADDING (B.2). Outside the cell is genuinely empty. Reflect or clamp
 *     padding fabricates border gradients and biases the estimate.
 *  3. ISOTROPIC GAUSSIAN PREFILTER (B.2), bias-free by Lemma B.1 (convolution
 *     commutes with translation), which is what widens the Taylor basin of
 *     §B.2.2 to cover the 1–3 px jitter range.
 *  4. GLOBALLY POOLED NORMALIZATION (§B.1). s_a and s_y are RMS gradient
 *     magnitudes pooled over ALL frames. Per-frame normalization would give
 *     every edge a subtly different objective and destroy the comparability of
 *     σ̂² across edges that (B.14) depends on. This is why the module consumes
 *     the whole frame set at once instead of mapping over it.
 */

import {
  ALPHA_EPSILON,
  LUMA_B,
  LUMA_G,
  LUMA_R,
  NORM_SCALE_FLOOR,
  PREFILTER_RADIUS_SIGMAS,
  PYRAMID_LEVELS,
} from "./constants";
import type {
  DecodedFrame,
  FrameSignal,
  PixelBox,
  SignalLevel,
  SignalPlane,
} from "./types";

/* ---------- kernel ---------- */

function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(PREFILTER_RADIUS_SIGMAS * sigma));
  const k = new Float32Array(2 * radius + 1);
  const inv = 1 / (2 * sigma * sigma);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-i * i * inv);
    k[i + radius] = v;
    sum += v;
  }
  // Normalized to unit mass so the filter is an average, not a gain.
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** Separable convolution with ZERO padding (B.2). Fixed traversal order. */
function blurZeroPadded(
  src: Float32Array,
  w: number,
  h: number,
  kernel: Float32Array
): Float32Array {
  const radius = (kernel.length - 1) >> 1;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let t = -radius; t <= radius; t++) {
        const xx = x + t;
        if (xx < 0 || xx >= w) continue; // zero outside
        acc += src[row + xx] * kernel[t + radius];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let t = -radius; t <= radius; t++) {
        const yy = y + t;
        if (yy < 0 || yy >= h) continue;
        acc += tmp[yy * w + x] * kernel[t + radius];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

/** Central differences; one-sided at the border, consistent with zero padding. */
function gradients(
  v: Float32Array,
  w: number,
  h: number
): { gx: Float32Array; gy: Float32Array } {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const xl = x > 0 ? v[row + x - 1] : 0;
      const xr = x < w - 1 ? v[row + x + 1] : 0;
      const yu = y > 0 ? v[row - w + x] : 0;
      const yd = y < h - 1 ? v[row + w + x] : 0;
      gx[row + x] = 0.5 * (xr - xl);
      gy[row + x] = 0.5 * (yd - yu);
    }
  }
  return { gx, gy };
}

/** 2×2 box average of the RAW premultiplied plane, before blurring. Averaging
 *  commutes with translation, so the coarse level inherits Lemma B.1. */
function downsample2(
  src: Float32Array,
  w: number,
  h: number
): { data: Float32Array; width: number; height: number } {
  const nw = Math.max(1, w >> 1);
  const nh = Math.max(1, h >> 1);
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const x0 = 2 * x;
      const y0 = 2 * y;
      const x1 = Math.min(w - 1, x0 + 1);
      const y1 = Math.min(h - 1, y0 + 1);
      out[y * nw + x] =
        0.25 *
        (src[y0 * w + x0] + src[y0 * w + x1] + src[y1 * w + x0] + src[y1 * w + x1]);
    }
  }
  return { data: out, width: nw, height: nh };
}

function supportBox(
  support: Float32Array,
  w: number,
  h: number
): PixelBox {
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  let any = false;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (support[row + x] > ALPHA_EPSILON) {
        any = true;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x >= maxX) maxX = x + 1;
        if (y >= maxY) maxY = y + 1;
      }
    }
  }
  return any
    ? { minX, minY, maxX, maxY }
    : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
}

/* ---------- raw premultiplied planes ---------- */

interface RawPlanes {
  alpha: Float32Array; // premultiplied α == α
  luma: Float32Array;  // α · Rec709 luminance  (B.1)
  support: Float32Array; // raw α ∈ [0,1] for m_ij (A.1)
  width: number;
  height: number;
}

function extractRaw(frame: DecodedFrame): RawPlanes {
  const { width, height, rgba } = frame;
  const n = width * height;
  const alpha = new Float32Array(n);
  const luma = new Float32Array(n);
  const support = new Float32Array(n);

  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = rgba[p + 3] / 255;
    support[i] = a;
    alpha[i] = a;
    // getImageData returns NON-premultiplied RGB, so we premultiply here (B.1).
    const lum =
      (LUMA_R * rgba[p] + LUMA_G * rgba[p + 1] + LUMA_B * rgba[p + 2]) / 255;
    luma[i] = a * lum;
  }
  return { alpha, luma, support, width, height };
}

/* ---------- level assembly ---------- */

interface PlaneDraft {
  value: Float32Array;
  gx: Float32Array;
  gy: Float32Array;
}

function buildPlaneDraft(
  raw: Float32Array,
  w: number,
  h: number,
  kernel: Float32Array
): PlaneDraft {
  const value = blurZeroPadded(raw, w, h, kernel);
  const { gx, gy } = gradients(value, w, h);
  return { value, gx, gy };
}

/** RMS gradient magnitude of a draft plane — the pooling statistic for s_c. */
function gradientSumSquares(d: PlaneDraft): { sum: number; count: number } {
  let sum = 0;
  for (let i = 0; i < d.gx.length; i++) {
    sum += d.gx[i] * d.gx[i] + d.gy[i] * d.gy[i];
  }
  return { sum, count: d.gx.length };
}

function finalizePlane(d: PlaneDraft, normScale: number): SignalPlane {
  const inv = 1 / normScale;
  const value = new Float32Array(d.value.length);
  const gx = new Float32Array(d.gx.length);
  const gy = new Float32Array(d.gy.length);
  for (let i = 0; i < value.length; i++) {
    value[i] = d.value[i] * inv;
    gx[i] = d.gx[i] * inv;
    gy[i] = d.gy[i] * inv;
  }
  return { value, gx, gy, normScale };
}

/* ---------- public API ---------- */

export interface SignalCache {
  get(hash: string): FrameSignal | undefined;
  set(hash: string, signal: FrameSignal): void;
}

/** Simple bounded LRU. Keyed by content hash, so it survives the wholesale
 *  data-URL replacement that every lasso commit performs. */
export function createSignalCache(limit = 128): SignalCache {
  const map = new Map<string, FrameSignal>();
  return {
    get(hash) {
      const hit = map.get(hash);
      if (hit) {
        map.delete(hash);
        map.set(hash, hit);
      }
      return hit;
    },
    set(hash, signal) {
      map.set(hash, signal);
      while (map.size > limit) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
    },
  };
}

/**
 * Build the two-level signal pyramid for every frame.
 *
 * Normalization is a TWO-PASS operation by necessity: pass one builds the
 * blurred planes and accumulates Σ‖∇‖² per channel per level across all
 * frames; pass two divides by the pooled RMS. That global coupling is the
 * whole reason this function takes an array rather than a single frame.
 */
export function buildSignals(
  frames: readonly DecodedFrame[],
  sigma: number,
  cache?: SignalCache
): FrameSignal[] {
  const kernel = gaussianKernel(sigma);
  const levels = PYRAMID_LEVELS;

  interface Draft {
    frame: DecodedFrame;
    perLevel: {
      width: number;
      height: number;
      alpha: PlaneDraft;
      luma: PlaneDraft;
      support: Float32Array;
    }[];
  }

  const drafts: Draft[] = [];
  // Pooled sums: [level][channel] where channel 0 = alpha, 1 = luma.
  const pooled: { sum: number; count: number }[][] = Array.from(
    { length: levels },
    () => [
      { sum: 0, count: 0 },
      { sum: 0, count: 0 },
    ]
  );

  for (const frame of frames) {
    const raw = extractRaw(frame);
    const perLevel: Draft["perLevel"] = [];

    let curAlpha = raw.alpha;
    let curLuma = raw.luma;
    let curSupport = raw.support;
    let w = raw.width;
    let h = raw.height;

    for (let l = 0; l < levels; l++) {
      if (l > 0) {
        const a = downsample2(curAlpha, w, h);
        const y = downsample2(curLuma, w, h);
        const s = downsample2(curSupport, w, h);
        curAlpha = a.data;
        curLuma = y.data;
        curSupport = s.data;
        w = a.width;
        h = a.height;
      }
      const alpha = buildPlaneDraft(curAlpha, w, h, kernel);
      const luma = buildPlaneDraft(curLuma, w, h, kernel);
      perLevel.push({ width: w, height: h, alpha, luma, support: curSupport });

      // Blank frames must not drag the pooled scale toward zero.
      if (frame.alphaMass > ALPHA_EPSILON) {
        const ga = gradientSumSquares(alpha);
        const gl = gradientSumSquares(luma);
        pooled[l][0].sum += ga.sum;
        pooled[l][0].count += ga.count;
        pooled[l][1].sum += gl.sum;
        pooled[l][1].count += gl.count;
      }
    }
    drafts.push({ frame, perLevel });
  }

  const scales = pooled.map((channels) =>
    channels.map((c) =>
      Math.max(NORM_SCALE_FLOOR, Math.sqrt(c.count > 0 ? c.sum / c.count : 0))
    )
  );

  return drafts.map((draft) => {
    const cached = cache?.get(draft.frame.hash);
    // Cache validity is content-only; the pooled scales depend on the whole
    // set, so a cache hit is only safe when the scales match. Cheapest correct
    // policy: compare the level-0 alpha scale.
    if (cached && cached.levels[0].alpha.normScale === scales[0][0]) {
      return cached;
    }

    const signalLevels: SignalLevel[] = draft.perLevel.map((lv, l) => {
      const alpha = finalizePlane(lv.alpha, scales[l][0]);
      const luma = finalizePlane(lv.luma, scales[l][1]);
      let energy = 0;
      for (let i = 0; i < alpha.gx.length; i++) {
        energy +=
          alpha.gx[i] * alpha.gx[i] +
          alpha.gy[i] * alpha.gy[i] +
          luma.gx[i] * luma.gx[i] +
          luma.gy[i] * luma.gy[i];
      }
      return {
        width: lv.width,
        height: lv.height,
        alpha,
        luma,
        support: lv.support,
        gradientEnergy: energy,
        supportBox: supportBox(lv.support, lv.width, lv.height),
      };
    });

    const signal: FrameSignal = {
      index: draft.frame.index,
      hash: draft.frame.hash,
      levels: signalLevels,
      usable: draft.frame.alphaMass > ALPHA_EPSILON,
    };
    cache?.set(draft.frame.hash, signal);
    return signal;
  });
}
