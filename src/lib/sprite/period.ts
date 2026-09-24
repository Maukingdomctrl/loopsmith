// === period.ts ===

/**
 * Loop Sprite Engine — period estimation.
 *
 * Given the interior gap centres of one axis, recover the cell pitch. Two
 * independent estimators, tried in order:
 *
 *   "gap-spacing"      the median of consecutive gap-centre differences.
 *                      Exact on any sheet that has visible gutters.
 *
 *   "autocorrelation"  the strongest non-trivial peak of the profile's
 *                      normalised autocorrelation. This is the ZERO-GUTTER
 *                      case: sprites packed edge to edge leave no below-
 *                      threshold run, so there are no gap centres at all, but
 *                      the profile is still periodic. Autocorrelation recovers
 *                      the PERIOD and says nothing about the PHASE — which is
 *                      why a candidate built from it is flagged
 *                      `phaseUnidentifiable` and can never be reported as
 *                      "exact".
 *
 * Everything is integer. The median of an even-length list takes the LOWER of
 * the two central values rather than their mean, so the result stays in ℤ and
 * no half-pixel pitch can ever enter the cut arithmetic.
 *
 * This module contains no ownership logic and no notion of a sprite. It reads a
 * profile and a list of integers and returns a pitch.
 */

import {
  DEFAULT_SPRITE_CONFIG,
  type GapInterval,
  type PeriodEstimate,
  type SpriteEngineConfig,
} from "./types";
import { gapCenters } from "./separatrix";

export const NO_PERIOD: PeriodEstimate = {
  method: "none",
  period: 0,
  divisions: 0,
  mad: 0,
  centers: [],
  irregular: false,
  strength: 0,
};

/** Lower median of a non-empty integer list. Sorts a copy; input untouched. */
function lowerMedian(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[(sorted.length - 1) >> 1];
}

/** Median absolute deviation about `center`, integer. */
function medianAbsoluteDeviation(
  values: readonly number[],
  center: number
): number {
  if (values.length === 0) return 0;
  const deviations: number[] = [];
  for (let i = 0; i < values.length; i++) {
    deviations.push(Math.abs(values[i] - center));
  }
  return lowerMedian(deviations);
}

/** Round-half-up integer division, for non-negative inputs. */
function divRound(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

/**
 * Pitch from gap spacing.
 *
 * Consecutive differences of the interior gap centres are the observed cell
 * pitches. Their median is robust to a missing gutter (one sprite whose body
 * bridges a cut, producing a 2p difference) and to an extra one (a sprite with
 * an internal flat band, producing two differences summing to p).
 *
 * `mad > 1` sets `irregular`: the sheet is not uniformly ruled, and the caller
 * must either fall back to measured cut vectors (when `allowIrregular`) or
 * decline the axis. One pixel of tolerance is allowed because a gutter centre
 * is itself a ⌊·⌋ of an even-width run and can legitimately alternate.
 */
export function periodFromGaps(
  gaps: readonly GapInterval[],
  extent: number,
  config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
): PeriodEstimate {
  const centers = gapCenters(gaps);
  if (centers.length < 1 || extent <= 0) return NO_PERIOD;

  const spacings: number[] = [];
  for (let i = 1; i < centers.length; i++) {
    const d = centers[i] - centers[i - 1];
    if (d > 0) spacings.push(d);
  }

  // A single interior gutter yields no spacing at all, but it does pin a
  // two-cell parse: the pitch is the distance from the extent origin doubled,
  // taken as extent/2 so the estimate stays consistent with `divisions`.
  if (spacings.length === 0) {
    const period = Math.floor(extent / 2);
    if (period < config.minCellSize) return NO_PERIOD;
    return {
      method: "gap-spacing",
      period,
      divisions: 2,
      mad: 0,
      centers,
      irregular: false,
      strength: 0,
    };
  }

  const period = lowerMedian(spacings);
  if (period < config.minCellSize) return NO_PERIOD;

  const mad = medianAbsoluteDeviation(spacings, period);
  let divisions = divRound(extent, period);
  if (divisions < 1) divisions = 1;
  if (divisions > config.maxDivisions) divisions = config.maxDivisions;

  return {
    method: "gap-spacing",
    period,
    divisions,
    mad,
    centers,
    irregular: mad > 1,
    strength: 0,
  };
}

/**
 * Pitch from the profile's normalised autocorrelation.
 *
 *   r(k) = Σ_i (x_i − x̄)(x_{i+k} − x̄) / Σ_i (x_i − x̄)²
 *
 * evaluated over lags k ∈ [minCellSize, ⌊n/2⌋], with the FIRST local maximum
 * that also exceeds every earlier value taken as the fundamental. Taking the
 * global maximum would systematically prefer k = 2p on a sheet with an even
 * number of frames, halving the reported frame count.
 *
 * A constant profile has Σ(x−x̄)² = 0 and returns NO_PERIOD: the photograph
 * gets no period, no candidates, and no chance to be accepted.
 */
export function periodFromAutocorrelation(
  profile: Uint32Array,
  config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
): PeriodEstimate {
  const n = profile.length;
  const maxLag = Math.floor(n / 2);
  if (n < 4 || maxLag < config.minCellSize) return NO_PERIOD;

  let sum = 0;
  for (let i = 0; i < n; i++) sum += profile[i];
  const mean = sum / n;

  const centered = new Float64Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const d = profile[i] - mean;
    centered[i] = d;
    energy += d * d;
  }
  if (energy <= 0) return NO_PERIOD;

  let bestLag = 0;
  let bestValue = 0;
  let previous = -Infinity;
  let rising = false;

  for (let k = config.minCellSize; k <= maxLag; k++) {
    let acc = 0;
    for (let i = 0; i + k < n; i++) acc += centered[i] * centered[i + k];
    const r = acc / energy;

    if (r > previous) {
      rising = true;
    } else if (rising) {
      // previous was a local maximum at lag k−1.
      if (previous > bestValue) {
        bestValue = previous;
        bestLag = k - 1;
      }
      // First qualifying peak is the fundamental; stop.
      if (bestValue >= config.minAutocorrelationStrength) break;
      rising = false;
    }
    previous = r;
  }

  if (bestLag === 0 || bestValue < config.minAutocorrelationStrength) {
    return NO_PERIOD;
  }

  let divisions = divRound(n, bestLag);
  if (divisions < 1) divisions = 1;
  if (divisions > config.maxDivisions) divisions = config.maxDivisions;

  return {
    method: "autocorrelation",
    period: bestLag,
    divisions,
    mad: 0,
    centers: [],
    irregular: false,
    strength: bestValue,
  };
}

/**
 * Preferred estimate for one axis: gap spacing when gutters exist, otherwise
 * autocorrelation. Gap spacing is tried first because it determines phase as
 * well as period, and phase is what makes an "exact" verdict possible.
 */
export function estimatePeriod(
  profile: Uint32Array,
  gaps: readonly GapInterval[],
  config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
): PeriodEstimate {
  const fromGaps = periodFromGaps(gaps, profile.length, config);
  if (fromGaps.method !== "none" && !fromGaps.irregular) return fromGaps;

  const fromAcf = periodFromAutocorrelation(profile, config);
  if (fromAcf.method !== "none") return fromAcf;

  return fromGaps;
}