// === occupancy.ts ===

/**
 * Adaptive occupancy generation.
 *
 * The rest of the engine never touches RGBA. It reads a single scalar field
 * I : Ω → [0,1] in Q8. Building that field correctly is what makes one theorem
 * serve transparent PNG, flattened PNG, JPEG and photographs alike.
 *
 * Three cases, decided by measurement rather than by file type:
 *
 *   A "alpha"       a meaningful alpha channel exists → I = α
 *   B "background"  opaque with a uniform background → I = normalised ‖c − b‖₁
 *   C "saturated"   no separable background → I ≡ 1
 *
 * Case C is the photograph. It yields a constant profile, hence σ_π = 0, hence
 * zero seam contrast, hence rejection by P1 — the failure mode is handled by
 * the general theorem instead of a special case. An opt-in "gradient" variant
 * of Case C substitutes edge energy for sheets on textured backgrounds.
 *
 * All thresholds here are MEASURED: the JPEG noise floor is the MAD of border
 * pixels about the background mode, and the contrast scale is a percentile of
 * the observed foreground distance. Nothing is tuned to a fixed magic number.
 */

import {
  DEFAULT_SPRITE_CONFIG,
  Q8_ONE,
  type OccupancyField,
  type OccupancyKind,
  type SpriteEngineConfig,
} from "./types";

/** 5 bits per channel: 32768 colour bins. */
const BIN_SHIFT = 3;
const BIN_LEVELS = 32;
const BIN_COUNT = BIN_LEVELS * BIN_LEVELS * BIN_LEVELS;

/** Maximum L1 distance between two 8-bit RGB triples. */
const MAX_L1 = 765;

function binIndex(r: number, g: number, b: number): number {
  return (
    ((r >> BIN_SHIFT) * BIN_LEVELS + (g >> BIN_SHIFT)) * BIN_LEVELS +
    (b >> BIN_SHIFT)
  );
}

/**
 * Smallest v whose cumulative histogram count reaches ⌈total·num/den⌉.
 * Integer-exact; replaces sorting, so the result is order-independent.
 */
function percentileFromHistogram(
  hist: Int32Array,
  total: number,
  numerator: number,
  denominator: number
): number {
  if (total <= 0) return 0;
  const target = Math.ceil((total * numerator) / denominator);
  let cumulative = 0;
  for (let v = 0; v < hist.length; v++) {
    cumulative += hist[v];
    if (cumulative >= target) return v;
  }
  return hist.length - 1;
}

function medianFromHistogram(hist: Int32Array, total: number): number {
  return percentileFromHistogram(hist, total, 1, 2);
}

interface AlphaCensus {
  readonly transparent: number;
  readonly translucent: number;
}

function censusAlpha(data: Uint8ClampedArray, pixels: number): AlphaCensus {
  let transparent = 0;
  let translucent = 0;
  for (let i = 0, p = 0; p < pixels; p++, i += 4) {
    const a = data[i + 3];
    if (a === 0) transparent++;
    else if (a !== 255) translucent++;
  }
  return { transparent, translucent };
}

function alphaIsMeaningful(
  census: AlphaCensus,
  pixels: number,
  config: SpriteEngineConfig
): boolean {
  const transparentNeeded = Math.max(
    1,
    Math.floor((pixels * config.alphaTransparentPermille) / 1000)
  );
  const translucentNeeded = Math.max(
    1,
    Math.floor((pixels * config.alphaTranslucentPermille) / 1000)
  );
  return (
    census.transparent >= transparentNeeded ||
    census.translucent >= translucentNeeded
  );
}

interface BackgroundEstimate {
  readonly uniform: boolean;
  /** Packed 0xRRGGBB mean of the modal border bin. */
  readonly color: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** Measured noise floor in L1 units: median + 3·MAD + 1. */
  readonly noiseFloor: number;
}

/**
 * Estimate the background from the 1-pixel border frame.
 *
 * Uniformity is tested INDEPENDENTLY of the derived noise floor: the modal
 * colour bin plus its 26 neighbours must hold `borderUniformPermille` of the
 * border. A photograph's border is spread across many bins and fails, so we
 * never fabricate a background that does not exist.
 */
function estimateBackground(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  config: SpriteEngineConfig
): BackgroundEstimate {
  const hist = new Int32Array(BIN_COUNT);
  const sumR = new Int32Array(BIN_COUNT);
  const sumG = new Int32Array(BIN_COUNT);
  const sumB = new Int32Array(BIN_COUNT);

  let borderCount = 0;

  const visit = (x: number, y: number): void => {
    const i = (y * width + x) * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const bin = binIndex(r, g, b);
    hist[bin]++;
    sumR[bin] += r;
    sumG[bin] += g;
    sumB[bin] += b;
    borderCount++;
  };

  // --- NEW: Inset by 2 pixels to safely ignore drawn bounding boxes ---
  const inset = 2;
  const minX = inset < width / 2 ? inset : 0;
  const maxX = width - 1 - minX;
  const minY = inset < height / 2 ? inset : 0;
  const maxY = height - 1 - minY;

  for (let x = minX; x <= maxX; x++) {
    visit(x, minY);
    if (maxY > minY) visit(x, maxY);
  }
  for (let y = minY + 1; y < maxY; y++) {
    visit(minX, y);
    if (maxX > minX) visit(maxX, y);
  }
  // ------------------------------------------------------------------

  if (borderCount === 0) {
    return { uniform: false, color: 0, r: 0, g: 0, b: 0, noiseFloor: 0 };
  }

  let modeBin = 0;
  let modeCount = -1;
  for (let bin = 0; bin < BIN_COUNT; bin++) {
    const c = hist[bin];
    if (c > modeCount) {
      modeCount = c;
      modeBin = bin;
    }
  }

  const count = hist[modeBin];
  const br = Math.floor(sumR[modeBin] / count);
  const bg = Math.floor(sumG[modeBin] / count);
  const bb = Math.floor(sumB[modeBin] / count);

  // Agreement over the modal bin and its 26 neighbours in quantised RGB.
  const mb = modeBin % BIN_LEVELS;
  const mg = Math.floor(modeBin / BIN_LEVELS) % BIN_LEVELS;
  const mr = Math.floor(modeBin / (BIN_LEVELS * BIN_LEVELS));
  let agree = 0;
  for (let dr = -1; dr <= 1; dr++) {
    const rr = mr + dr;
    if (rr < 0 || rr >= BIN_LEVELS) continue;
    for (let dg = -1; dg <= 1; dg++) {
      const gg = mg + dg;
      if (gg < 0 || gg >= BIN_LEVELS) continue;
      for (let db = -1; db <= 1; db++) {
        const bbq = mb + db;
        if (bbq < 0 || bbq >= BIN_LEVELS) continue;
        agree += hist[(rr * BIN_LEVELS + gg) * BIN_LEVELS + bbq];
      }
    }
  }

  const uniform =
    agree * 1000 >= borderCount * config.borderUniformPermille;

  // Noise floor: median absolute deviation of border distance about the mode.
  const distHist = new Int32Array(MAX_L1 + 1);
  const collect = (x: number, y: number): void => {
    const i = (y * width + x) * 4;
    const d =
      Math.abs(data[i] - br) +
      Math.abs(data[i + 1] - bg) +
      Math.abs(data[i + 2] - bb);
    distHist[d]++;
  };

  // --- NEW: Use the same inset bounds for the noise floor collection ---
  for (let x = minX; x <= maxX; x++) {
    collect(x, minY);
    if (maxY > minY) collect(x, maxY);
  }
  for (let y = minY + 1; y < maxY; y++) {
    collect(minX, y);
    if (maxX > minX) collect(maxX, y);
  }
  // -------------------------------------------------------------------

  const med = medianFromHistogram(distHist, borderCount);
  const devHist = new Int32Array(MAX_L1 + 1);
  for (let d = 0; d <= MAX_L1; d++) {
    const c = distHist[d];
    if (c > 0) devHist[Math.abs(d - med)] += c;
  }
  const mad = medianFromHistogram(devHist, borderCount);

  return {
    uniform,
    color: (br << 16) | (bg << 8) | bb,
    r: br,
    g: bg,
    b: bb,
    noiseFloor: med + 3 * mad + 1,
  };
}
function finalise(
  width: number,
  height: number,
  out: Uint8Array,
  

  kind: OccupancyKind,
  background: number | null,
  noiseFloor: number
): OccupancyField {
  // Σ and support size are computed once, here, in a single fixed-order pass.
  // Every later stage that needs a mass fraction reads `totalMass` rather than
  // re-summing, so no two stages can ever disagree about the total.
  //
  // Bound: 64e6 px × 255 = 1.632e10 < 2^53, so the accumulator is an exact
  // integer in float64 and the sum is associativity-independent in practice
  // (all partial sums are integers, hence every addition is exact).
  let totalMass = 0;
  let occupiedCount = 0;
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    if (v > 0) {
      totalMass += v;
      occupiedCount++;
    }
  }
  return {
    width,
    height,
    data: out,
    kind,
    background,
    noiseFloor,
    totalMass,
    occupiedCount,
  };
}

/**
 * Smallest v > floor whose cumulative count, taken over the strictly-above-floor
 * tail only, reaches the requested fraction.
 *
 * Restricting to the tail is the whole point: we want a percentile of the
 * FOREGROUND distance distribution, and in a typical sprite sheet 80–95% of all
 * pixels are background. A whole-image percentile would sit inside the noise
 * floor and normalise every sprite to pure white.
 */
function percentileAboveFloor(
  hist: Int32Array,
  floor: number,
  numerator: number,
  denominator: number
): number {
  const last = hist.length - 1;
  let total = 0;
  for (let v = floor + 1; v <= last; v++) total += hist[v];
  if (total <= 0) return floor + 1;

  const target = Math.ceil((total * numerator) / denominator);
  let cumulative = 0;
  for (let v = floor + 1; v <= last; v++) {
    cumulative += hist[v];
    if (cumulative >= target) return v;
  }
  return last;
}

/**
 * Median and MAD of a histogram, restricted to the tail above `floor`.
 * Used to derive a noise floor for fields (edge energy) that have no border
 * frame to sample from.
 */
function tailMedianAndMad(
  hist: Int32Array,
  floor: number
): { median: number; mad: number } {
  const last = hist.length - 1;
  let total = 0;
  for (let v = floor; v <= last; v++) total += hist[v];
  if (total <= 0) return { median: floor, mad: 0 };

  const halfTarget = Math.ceil(total / 2);
  let cumulative = 0;
  let median = floor;
  for (let v = floor; v <= last; v++) {
    cumulative += hist[v];
    if (cumulative >= halfTarget) {
      median = v;
      break;
    }
  }

  const devHist = new Int32Array(hist.length);
  for (let v = floor; v <= last; v++) {
    const c = hist[v];
    if (c > 0) devHist[Math.abs(v - median)] += c;
  }

  cumulative = 0;
  let mad = 0;
  for (let d = 0; d <= last; d++) {
    cumulative += devHist[d];
    if (cumulative >= halfTarget) {
      mad = d;
      break;
    }
  }
  return { median, mad };
}

/**
 * Build the Q8 ramp `distance → occupancy` once, then apply it as a lookup.
 *
 *   I(d) = 0                                    d ≤ floor
 *          clamp₂₅₅( ⌊(d − floor)·255 / span⌋ ) d > floor,  span = scale − floor
 *
 * Piecewise-linear with a dead zone, so JPEG ringing around a sprite (which
 * lives at d ≲ floor) contributes exactly zero mass, while genuine antialiasing
 * (which ramps smoothly past floor) keeps its partial occupancy. That is the
 * property the leakage test in ownership.ts depends on: soft edges must stay
 * soft, or every antialiased sprite would look like it leaks into its gutter.
 */
function buildRamp(length: number, floor: number, scale: number): Uint8Array {
  const ramp = new Uint8Array(length);
  const span = Math.max(1, scale - floor);
  for (let d = floor + 1; d < length; d++) {
    const v = Math.floor(((d - floor) * Q8_ONE) / span);
    ramp[d] = v >= Q8_ONE ? Q8_ONE : v;
  }
  return ramp;
}

/**
 * Case A — a meaningful alpha channel exists, so occupancy IS alpha.
 *
 * No thresholding, no noise floor: the encoder already told us, per pixel and
 * exactly, how much of it is sprite. Preserving the fractional values matters
 * because antialiased sprite borders are precisely where the leakage statistic
 * is most sensitive.
 */
function buildAlphaField(
  data: Uint8ClampedArray,
  width: number,
  height: number
): OccupancyField {
  const pixels = width * height;
  const out = new Uint8Array(pixels);
  for (let p = 0, i = 3; p < pixels; p++, i += 4) {
    out[p] = data[i];
  }
  return finalise(width, height, out, "alpha", null, 0);
}

/**
 * Case B — opaque image with a uniform background colour.
 *
 * I = ramp(‖c(x) − b‖₁), with the ramp's dead zone set to the MEASURED border
 * noise floor and its saturation point set to the 90th percentile of foreground
 * distance. Both endpoints come from this image; neither is a constant.
 *
 * Why L1 rather than L2 in RGB: it is exact in integer arithmetic (no √, no
 * rounding), it is monotone in every channel, and the subsequent percentile
 * normalisation makes the choice of norm immaterial to the threshold — only the
 * ORDERING of pixels by distance matters, and L1 and L2 agree on ordering for
 * the near-axis differences that dominate sprite-vs-background contrast.
 */
function buildBackgroundField(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  bg: BackgroundEstimate,
  config: SpriteEngineConfig
): OccupancyField {
  const pixels = width * height;
  const distances = new Uint16Array(pixels);
  const hist = new Int32Array(MAX_L1 + 1);

  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    const d =
      Math.abs(data[i] - bg.r) +
      Math.abs(data[i + 1] - bg.g) +
      Math.abs(data[i + 2] - bg.b);
    distances[p] = d;
    hist[d]++;
  }

  const floor = Math.min(MAX_L1 - 1, bg.noiseFloor);
  const scale = percentileAboveFloor(
    hist,
    floor,
    config.contrastScalePermille,
    1000
  );
  const ramp = buildRamp(MAX_L1 + 1, floor, scale);

  const out = new Uint8Array(pixels);
  for (let p = 0, i = 3; p < pixels; p++, i += 4) {
    const v = ramp[distances[p]];
    if (v === 0) continue;
    const a = data[i];
    // Alpha was not *meaningful* (too few non-opaque pixels to be a mask), but
    // where it is present it is still authoritative. Modulating by it costs one
    // multiply on a rare branch and prevents stray translucent artefacts from
    // being counted as solid ink.
    out[p] = a === 255 ? v : Math.floor((v * a) / 255);
  }

  return finalise(width, height, out, "background", bg.color, floor);
}

/**
 * Case C, opt-in variant — textured background, so no single colour separates
 * figure from ground. Substitute local edge energy for colour distance.
 *
 *   E(x,y) = |L(x+1,y) − L(x−1,y)| + |L(x,y+1) − L(x,y−1)|
 *
 * on integer BT.601 luma, with replicated borders. Gutters in a sprite sheet
 * are flat by construction, so E ≈ 0 there whatever the background texture is,
 * while sprite interiors and outlines carry energy.
 *
 * This is OFF by default (`gradientFallback: false`). It changes what "sprite
 * content" means — interiors of large flat sprites register as empty — and that
 * is a trade the caller should make deliberately rather than inherit.
 */
function buildGradientField(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  config: SpriteEngineConfig
): OccupancyField {
  const pixels = width * height;

  const luma = new Uint8Array(pixels);
  for (let p = 0, i = 0; p < pixels; p++, i += 4) {
    // Weights sum to 256, so the shift is an exact divide by 256.
    luma[p] = (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2]) >> 8;
  }

  const MAX_ENERGY = 510;
  const energy = new Uint16Array(pixels);
  const hist = new Int32Array(MAX_ENERGY + 1);

  for (let y = 0; y < height; y++) {
    const yUp = y > 0 ? y - 1 : 0;
    const yDown = y + 1 < height ? y + 1 : height - 1;
    const rowUp = yUp * width;
    const rowDown = yDown * width;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const xL = x > 0 ? x - 1 : 0;
      const xR = x + 1 < width ? x + 1 : width - 1;
      const e =
        Math.abs(luma[row + xR] - luma[row + xL]) +
        Math.abs(luma[rowDown + x] - luma[rowUp + x]);
      energy[row + x] = e;
      hist[e]++;
    }
  }

  // With no border frame to characterise, the noise floor is the median energy
  // plus 3 MAD over the whole field. On a textured sheet the texture IS the
  // bulk of the distribution, so this floor sits just above it by construction.
  const { median, mad } = tailMedianAndMad(hist, 0);
  const floor = Math.min(MAX_ENERGY - 1, median + 3 * mad + 1);
  const scale = percentileAboveFloor(
    hist,
    floor,
    config.contrastScalePermille,
    1000
  );
  const ramp = buildRamp(MAX_ENERGY + 1, floor, scale);

  const out = new Uint8Array(pixels);
  for (let p = 0; p < pixels; p++) {
    out[p] = ramp[energy[p]];
  }

  return finalise(width, height, out, "gradient", null, floor);
}

/**
 * Case C — no separable background. Every pixel is content.
 *
 * This is the photograph, and it is deliberately NOT a special case in the
 * detector. A constant field has constant marginal projections; a constant
 * profile has zero variance; zero variance yields zero seam contrast; and P1
 * then rejects every candidate on the ordinary statistical path. The photograph
 * is refused by the same theorem that accepts a sprite sheet, which is exactly
 * why it cannot be "fixed" into acceptance by tuning a threshold elsewhere.
 */
function buildSaturatedField(width: number, height: number): OccupancyField {
  const out = new Uint8Array(width * height);
  out.fill(Q8_ONE);
  return finalise(width, height, out, "saturated", null, 0);
}

/**
 * Derive the occupancy field for an image, choosing the case by measurement.
 *
 * Decision order, and why it is this order:
 *
 *   1. Alpha, if meaningful. It is ground truth supplied by the encoder; no
 *      inference can beat it, so nothing else is consulted.
 *   2. Uniform background, if the border frame agrees to within
 *      `borderUniformPermille`. Uniformity is judged BEFORE and INDEPENDENTLY
 *      of the noise floor it would imply, so a photograph cannot bootstrap a
 *      fictitious background by widening its own tolerance.
 *   3. Otherwise saturated (or gradient, if the caller opted in).
 *
 * Throws only on inputs beyond `maxPixels`; `detectSpriteGrid` validates size
 * before calling, so that branch is unreachable through the public API and
 * exists to keep this function total for direct callers.
 */
export function buildOccupancy(
  image: ImageData,
  config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
): OccupancyField {
  const { width, height, data } = image;

  if (width <= 0 || height <= 0) {
    return finalise(
      Math.max(0, width),
      Math.max(0, height),
      new Uint8Array(0),
      "saturated",
      null,
      0
    );
  }

    const pixels = width * height;

  if (pixels > config.maxPixels) {
    throw new RangeError(
      `Image of ${pixels} pixels exceeds maxPixels (${config.maxPixels}).`
    );
  }

  const census = censusAlpha(data, pixels);

  if (alphaIsMeaningful(census, pixels, config)) {
    return buildAlphaField(data, width, height);
  }

  const bg = estimateBackground(data, width, height, config);

  if (bg.uniform) {
    return buildBackgroundField(data, width, height, bg, config);
  }

  if (config.gradientFallback) {
    return buildGradientField(data, width, height, config);
  }

  return buildSaturatedField(width, height);
}