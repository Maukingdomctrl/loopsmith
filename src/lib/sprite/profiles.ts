// === profiles.ts ===

/**
 * Loop Sprite Engine — marginal projection profiles.
 *
 * Collapses the 2-D occupancy field onto its two exact marginals and derives
 * the statistics and the Otsu split point that the separatrix stage consumes.
 *
 * This module makes NO grid decisions. It contains no notion of a cut, a cell
 * or a candidate; it only turns a field into two integer signals plus their
 * descriptive statistics. Every number it produces is a deterministic function
 * of the input array, computed in a fixed traversal order with integer
 * accumulators, so two runs on identical bytes are bit-identical.
 *
 * Bound on the accumulators: a 64e6-pixel field with every sample at Q8_ONE
 * sums to 1.632e10 per axis in total, but any single row or column sums to at
 * most 65536 · 255 = 1.671e7 < 2^32, so Uint32Array is exact for the profiles
 * themselves. Means and variances are float64 and are computed from integer
 * sums of squares, which stay below 2^53 for every admissible input.
 */

import {
  DEFAULT_SPRITE_CONFIG,
  type OccupancyField,
  type ProfileStats,
  type ProjectionProfiles,
  type SpriteEngineConfig,
} from "./types";

const EMPTY_STATS: ProfileStats = {
  count: 0,
  mean: 0,
  variance: 0,
  stdDev: 0,
  min: 0,
  max: 0,
};

/**
 * Exact row sums: rows[y] = Σ_x I(x,y).
 *
 * Row-major traversal, so the access pattern is linear in memory and the
 * summation order is fully determined by (y, x) — never by a partitioning
 * scheme that could vary between engines.
 */
export function computeRowSums(field: OccupancyField): Uint32Array {
  const { width, height, data } = field;
  const rows = new Uint32Array(height);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    let sum = 0;
    for (let x = 0; x < width; x++) sum += data[base + x];
    rows[y] = sum;
  }
  return rows;
}

/**
 * Exact column sums: columns[x] = Σ_y I(x,y).
 *
 * Accumulated in row-major order into a single output vector rather than by
 * striding down each column: one linear pass over the field instead of W
 * cache-hostile passes, with identical arithmetic because integer addition of
 * a fixed multiset in a fixed order is exact either way.
 */
export function computeColumnSums(field: OccupancyField): Uint32Array {
  const { width, height, data } = field;
  const columns = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) columns[x] += data[base + x];
  }
  return columns;
}

/**
 * One pass of a radius-1 box filter, evaluated through a prefix sum so the
 * cost is O(n) independent of the radius, and the result is integer-exact.
 *
 *   out[i] = ⌊ (Σ_{j=i−r}^{i+r} in[j]) / (window size) ⌋
 *
 * Borders are handled by clamping the window to the array, which shortens the
 * divisor accordingly. That keeps the filter mean-preserving at the edges
 * instead of biasing the first and last positions toward zero — an edge bias
 * would manufacture phantom gutters in the outer margins, which is exactly
 * where a real sheet often has genuine content flush to the border.
 *
 * Prefix sums are computed in float64 but hold only integers: the total mass
 * of one axis is at most 1.632e10 < 2^53, so every partial sum is exact.
 */
export function boxSmooth(profile: Uint32Array, radius: number): Uint32Array {
  const n = profile.length;
  const out = new Uint32Array(n);
  if (n === 0) return out;
  if (radius <= 0) {
    out.set(profile);
    return out;
  }

  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + profile[i];

  for (let i = 0; i < n; i++) {
    const lo = i - radius < 0 ? 0 : i - radius;
    const hiExclusive = i + radius + 1 > n ? n : i + radius + 1;
    const count = hiExclusive - lo;
    out[i] = Math.floor((prefix[hiExclusive] - prefix[lo]) / count);
  }
  return out;
}

/** Apply `passes` radius-1 box passes. Zero passes returns a defensive copy. */
export function smoothProfile(profile: Uint32Array, passes: number): Uint32Array {
  let current: Uint32Array = new Uint32Array(profile);
  for (let p = 0; p < passes; p++) current = boxSmooth(current, 1);
  return current;
}

/**
 * Descriptive statistics over `profile[start..end)`.
 *
 * Variance uses the two-pass form (mean first, then squared deviations) rather
 * than the E[X²] − E[X]² shortcut. With profile values up to 1.7e7 the
 * shortcut's catastrophic cancellation is not hypothetical: a nearly-constant
 * profile — the photograph case, where σ ≈ 0 is the whole signal — is precisely
 * where it loses all its significant digits, and σ feeds the P1 critical value.
 */
export function profileStats(
  profile: Uint32Array,
  start = 0,
  end = profile.length
): ProfileStats {
  const lo = start < 0 ? 0 : start;
  const hi = end > profile.length ? profile.length : end;
  const count = hi - lo;
  if (count <= 0) return EMPTY_STATS;

  let sum = 0;
  let min = profile[lo];
  let max = profile[lo];
  for (let i = lo; i < hi; i++) {
    const v = profile[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / count;

  let sq = 0;
  for (let i = lo; i < hi; i++) {
    const d = profile[i] - mean;
    sq += d * d;
  }
  const variance = sq / count;

  return {
    count,
    mean,
    variance,
    stdDev: Math.sqrt(variance),
    min,
    max,
  };
}

/** Number of histogram bins used by the Otsu implementation. */
const OTSU_BINS = 256;

/**
 * Integer Otsu threshold on a profile, returned in PROFILE UNITS.
 *
 * The profile is binned into 256 levels spanning [min, max]; the classic
 * between-class variance criterion is maximised over bin boundaries using
 * integer class counts and integer class sums, so the comparison
 *
 *      (Σ₀·n₁ − Σ₁·n₀)²  vs.  best · n₀ · n₁
 *
 * is evaluated without ever forming a ratio. Ties select the LOWEST qualifying
 * boundary, which is the conservative choice: it makes fewer positions count as
 * gaps, so a marginal sheet is rejected rather than over-parsed.
 *
 * Why Otsu rather than "value == 0": a JPEG-compressed sheet has a measured
 * noise floor, so its gutters carry small but non-zero occupancy; a fixed zero
 * test finds no gaps at all and the sheet is declared a photograph. Otsu adapts
 * the split point to the bimodality actually present in this image.
 *
 * Degenerate input (constant profile) yields `min`, under which no position is
 * strictly below threshold except by the `v <= t` convention — which is what we
 * want: a constant profile must not produce gaps.
 */
export function otsuThreshold(profile: Uint32Array): number {
  const n = profile.length;
  if (n === 0) return 0;

  let min = profile[0];
  let max = profile[0];
  for (let i = 1; i < n; i++) {
    const v = profile[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max <= min) return min;

  const span = max - min;
  const hist = new Int32Array(OTSU_BINS);
  for (let i = 0; i < n; i++) {
    let bin = Math.floor(((profile[i] - min) * (OTSU_BINS - 1)) / span);
    if (bin < 0) bin = 0;
    else if (bin >= OTSU_BINS) bin = OTSU_BINS - 1;
    hist[bin]++;
  }

  let total = 0;
  for (let b = 0; b < OTSU_BINS; b++) total += hist[b] * b;

  let bestNumerator = -1;
  let bestDenominator = 1;
  let bestBin = 0;

  let countLow = 0;
  let sumLow = 0;
  for (let b = 0; b < OTSU_BINS - 1; b++) {
    countLow += hist[b];
    sumLow += hist[b] * b;
    const countHigh = n - countLow;
    if (countLow === 0 || countHigh === 0) continue;

    const sumHigh = total - sumLow;
    const delta = sumLow * countHigh - sumHigh * countLow;
    const numerator = delta * delta;
    const denominator = countLow * countHigh;

    // numerator/denominator > best/bestDenominator, cross-multiplied.
    if (numerator * bestDenominator > bestNumerator * denominator) {
      bestNumerator = numerator;
      bestDenominator = denominator;
      bestBin = b;
    }
  }

  return min + Math.floor((bestBin * span) / (OTSU_BINS - 1));
}

/**
 * Build both marginals, their smoothed copies, their statistics and their
 * Otsu split points.
 *
 * Thresholds are computed on the SMOOTHED profile because that is the signal
 * gap extraction reads; computing them on the raw profile and applying them to
 * the smoothed one would compare two different distributions.
 */
export function buildProfiles(
  field: OccupancyField,
  config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
): ProjectionProfiles {
  const columns = computeColumnSums(field);
  const rows = computeRowSums(field);
  const smoothedColumns = smoothProfile(columns, config.smoothingPasses);
  const smoothedRows = smoothProfile(rows, config.smoothingPasses);

  return {
    width: field.width,
    height: field.height,
    columns,
    rows,
    smoothedColumns,
    smoothedRows,
    columnStats: profileStats(smoothedColumns),
    rowStats: profileStats(smoothedRows),
    columnThreshold: otsuThreshold(smoothedColumns),
    rowThreshold: otsuThreshold(smoothedRows),
  };
}