  // === separatrix.ts ===

  /**
   * Loop Sprite Engine — the separatrix stage.
   *
   * A *separatrix* is the locus that separates two sprites: a gutter. Everything
   * in this file exists to answer one question with a number rather than a guess:
   *
   *     Do the cut lines of a proposed grid land on gutters,
   *     or would arbitrary lines have done just as well?
   *
   * The stage has three parts, in dependency order:
   *
   *   1. GAP EXTRACTION. Extract maximal below-threshold runs as GapIntervals
   *      from a smoothed marginal profile. Otsu is used rather than a fixed
   *      constant because the correct gutter level depends entirely on the sheet:
   *      a JPEG with a noise floor of 30 L1 units has non-zero gutters, and a
   *      fixed "== 0" test would find none.
   *
   *   2. SEAM TESTING. Given a candidate's cut vector, decide predicates P1
   *      (significance) and P2 (separation).
   *
   * WHY A HYPOTHESIS TEST AND NOT A THRESHOLD
   * -----------------------------------------
   * The failure this engine was built to eliminate is a 38×57 grid "detected" in
   * a photograph. Any fixed rule of the form "seam energy < c" is defeated by
   * rescaling the image contrast, and any rule of the form "seam energy < c ·
   * mean" is defeated by a dense sheet. The only scale-free, content-free
   * statement is a comparison against the null hypothesis
   *
   *     H₀ : the cut positions are unrelated to the content,
   *
   * whose sampling distribution we estimate directly from the image by evaluating
   * the *same statistic* at every admissible position. If a candidate's seams are
   * not several standard errors below that empirical baseline, the grid is a
   * coincidence and is rejected. On a photograph the marginal profile is nearly
   * constant, σ ≈ 0 and κ ≈ 0, so every candidate fails — the pathological input
   * is handled by the general theorem instead of by a special case.
   *
   * MATCHED STATISTIC
   * -----------------
   * Cut placement is only accurate to ±1 px after remainder cropping, so a seam
   * is therefore not sampled at a single index but as the MINIMUM over a window of
   * half-width `config.seamRadius` centred on the cut. Taking the minimum rather
   * than the mean is deliberate: the question P2 asks is "does a gutter exist
   * near this line", and a gutter one pixel off-centre is still a gutter, whereas
   * a mean would be dragged upward by the sprite body on either side and would
   * reject correct grids on dense sheets.
   *
   * The same windowed statistic is used for the baseline, so κ compares like with
   * like and the ±1 tolerance cannot by itself manufacture contrast.
   */

  import {
    DEFAULT_SPRITE_CONFIG,
    type GapInterval,
    type ProjectionProfiles,
    type SeamEvidence,
    type SpriteEngineConfig,
  } from "./types";

  /** Vacuous evidence, used when an axis has a single division. */
  export const VACUOUS_SEAM: SeamEvidence = {
    seamCount: 0,
    seamEnergy: 0,
    baseline: 0,
    contrast: 0,
    criticalContrast: 0,
    zScore: 0,
    significant: true,
    separated: true,
    worstSeamValue: 0,
    vacuous: true,
  };

  /**
   * One-sided normal critical values, tabulated because `significanceAlpha` must
   * name an entry rather than be interpolated: an inverse-erf approximation would
   * make the acceptance boundary depend on a numerical library's rounding.
   * Unknown α falls back to the strictest tabulated value, never to a lax one.
   */
  const Z_TABLE: readonly (readonly [number, number])[] = [
    [0.1, 1.2816],
    [0.05, 1.6449],
    [0.025, 1.9600],
    [0.01, 2.3263],
    [0.005, 2.5758],
    [0.001, 3.0902],
    [0.0005, 3.2905],
    [0.0001, 3.7190],
  ];

  export function criticalZ(alpha: number): number {
    for (let i = 0; i < Z_TABLE.length; i++) {
      if (Z_TABLE[i][0] === alpha) return Z_TABLE[i][1];
    }
    let strictest = Z_TABLE[0][1];
    for (let i = 1; i < Z_TABLE.length; i++) {
      if (Z_TABLE[i][1] > strictest) strictest = Z_TABLE[i][1];
    }
    return strictest;
  }

  // ---------------------------------------------------------------------------
  // Gap extraction
  // ---------------------------------------------------------------------------

  /**
   * Extract every maximal run of positions with `profile[i] <= threshold`.
   *
   * Runs shorter than `minGapWidth` are discarded: a single below-threshold
   * column inside a sprite (a horizontal slice of background between two limbs)
   * is not a gutter, and admitting it would multiply the candidate space by the
   * number of such accidents.
   *
   * `border` marks runs touching position 0 or n−1. Those are outer margins, not
   * separatrices, and the period estimator must exclude them: a sheet with a
   * 12 px left margin and a 4 px gutter pitch would otherwise report a spacing
   * derived from a margin centre that corresponds to no cut at all.
   */
  export function extractGaps(
    profile: Uint32Array,
    threshold: number,
    minGapWidth: number
  ): GapInterval[] {
    const n = profile.length;
    const gaps: GapInterval[] = [];
    const minWidth = minGapWidth < 1 ? 1 : minGapWidth;

    let runStart = -1;
    let runSum = 0;

    const close = (endInclusive: number): void => {
      const width = endInclusive - runStart + 1;
      if (width >= minWidth) {
        gaps.push({
          start: runStart,
          end: endInclusive,
          center: runStart + ((width - 1) >> 1),
          width,
          meanValue: runSum / width,
          border: runStart === 0 || endInclusive === n - 1,
        });
      }
      runStart = -1;
      runSum = 0;
    };

    for (let i = 0; i < n; i++) {
      if (profile[i] <= threshold) {
        if (runStart < 0) {
          runStart = i;
          runSum = 0;
        }
        runSum += profile[i];
      } else if (runStart >= 0) {
        close(i - 1);
      }
    }
    if (runStart >= 0) close(n - 1);

    return gaps;
  }

  /** Interior gaps only, ascending by centre. The input to period estimation. */
  export function interiorGaps(gaps: readonly GapInterval[]): GapInterval[] {
    const out = gaps.filter((g) => !g.border);
    out.sort((a, b) => (a.center - b.center) || (a.start - b.start));
    return out;
  }

  /** Gap centres, ascending, deduplicated. */
  export function gapCenters(gaps: readonly GapInterval[]): number[] {
    const centers: number[] = [];
    const sorted = interiorGaps(gaps);
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i].center;
      if (i === 0 || c !== centers[centers.length - 1]) centers.push(c);
    }
    return centers;
  }

  // ---------------------------------------------------------------------------
  // Windowed sampling
  // ---------------------------------------------------------------------------

  /**
   * Minimum of `profile` over [p−r, p+r] ∩ [lo, hi].
   *
   * Out-of-range windows return the configured `fallback` rather than 0, so a cut
   * placed at the very edge of the extent cannot be credited with a free gutter.
   */
  function windowMin(
    profile: Uint32Array,
    p: number,
    radius: number,
    lo: number,
    hi: number,
    fallback: number
  ): number {
    const start = p - radius < lo ? lo : p - radius;
    const end = p + radius > hi ? hi : p + radius;
    if (start > end) return fallback;
    let best = profile[start];
    for (let i = start + 1; i <= end; i++) {
      if (profile[i] < best) best = profile[i];
    }
    return best;
  }

  /**
   * Mean and stddev of the windowed minimum over EVERY admissible position.
   *
   * This is the H₀ baseline: the expected value of the seam statistic when the
   * cut positions carry no information about the content. Estimating it from the
   * same image, with the same window, is what makes κ scale-free — doubling the
   * image contrast doubles both seamEnergy and baseline and leaves κ fixed.
   */
  function baselineStats(
    profile: Uint32Array,
    radius: number,
    lo: number,
    hi: number
  ): { mean: number; stdDev: number; count: number } {
    const count = hi - lo + 1;
    if (count <= 0) return { mean: 0, stdDev: 0, count: 0 };

    const samples = new Float64Array(count);
    let sum = 0;
    for (let i = 0; i < count; i++) {
      const v = windowMin(profile, lo + i, radius, lo, hi, 0);
      samples[i] = v;
      sum += v;
    }
    const mean = sum / count;

    let sq = 0;
    for (let i = 0; i < count; i++) {
      const d = samples[i] - mean;
      sq += d * d;
    }
    return { mean, stdDev: Math.sqrt(sq / count), count };
  }

  // ---------------------------------------------------------------------------
  // P1 significance and P2 separation
  // ---------------------------------------------------------------------------

  /**
   * Evaluate the seam predicates for one axis of one candidate.
   *
   * `cuts` is the full absolute cut vector of length divisions+1; only the
   * INTERIOR entries cuts[1..divisions−1] are tested, because the outer edges of
   * a sheet are not separatrices and are trivially satisfied by cropping.
   *
   * P1 (significance): κ = 1 − seamEnergy/baseline must reach the critical
   * contrast z·σ / (√m · baseline), where m is the number of interior seams. The
   * √m is the standard error of the mean of m samples: a 2-column grid must clear
   * a much higher bar than a 16-column grid, which is the correct asymmetry —
   * a single accidentally-clean line is common, sixteen are not.
   *
   * P2 (separation): every interior seam's windowed value must itself lie at or
   * below the Otsu gap threshold. P1 alone is a statement about averages, and an
   * average can be dragged below the bar by ten immaculate gutters while one cut
   * slices a sprite in half. P2 is the per-seam guarantee that no cut crosses ink.
   *
   * A degenerate baseline (constant profile — the photograph) yields κ = 0 and
   * criticalContrast = 0 with `significant` false: no candidate can pass, and the
   * rejection comes from the general test rather than from a special case.
   */
  export function evaluateSeams(
    profile: Uint32Array,
    cuts: readonly number[],
    divisions: number,
    threshold: number,
    config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
  ): SeamEvidence {
    const seamCount = divisions - 1;
    if (seamCount <= 0) return VACUOUS_SEAM;

    const lo = cuts[0];
    const hi = cuts[divisions] - 1;
    if (hi <= lo) return VACUOUS_SEAM;

    const radius = config.seamRadius < 0 ? 0 : config.seamRadius;
    const base = baselineStats(profile, radius, lo, hi);

    let sum = 0;
    let worst = 0;
    let separated = true;
    for (let k = 1; k < divisions; k++) {
      const v = windowMin(profile, cuts[k], radius, lo, hi, base.mean);
      sum += v;
      if (v > worst) worst = v;
      if (v > threshold) separated = false;
    }
    const seamEnergy = sum / seamCount;

    const baseline = base.mean;
    const contrast = baseline > 0 ? 1 - seamEnergy / baseline : 0;

    const z = criticalZ(config.significanceAlpha);
    const standardError = base.stdDev / Math.sqrt(seamCount);
    const criticalContrast =
      baseline > 0 ? (z * standardError) / baseline : 0;

    const zScore =
      standardError > 0 ? (baseline - seamEnergy) / standardError : 0;

    // A strictly positive contrast is required even when σ = 0: a constant
    // profile has criticalContrast = 0, and without this clause every candidate
    // on a photograph would satisfy "0 >= 0".
    const significant =
      baseline > 0 && contrast > 0 && contrast >= criticalContrast;

    return {
      seamCount,
      seamEnergy,
      baseline,
      contrast,
      criticalContrast,
      zScore,
      significant,
      separated,
      worstSeamValue: worst,
      vacuous: false,
    };
  }

  /** Convenience: evaluate the X axis of a cut vector against the profiles. */
  export function evaluateSeamsX(
    profiles: ProjectionProfiles,
    cuts: readonly number[],
    cols: number,
    config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
  ): SeamEvidence {
    return evaluateSeams(
      profiles.smoothedColumns,
      cuts,
      cols,
      profiles.columnThreshold,
      config
    );
  }

  /** Convenience: evaluate the Y axis of a cut vector against the profiles. */
  export function evaluateSeamsY(
    profiles: ProjectionProfiles,
    cuts: readonly number[],
    rows: number,
    config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
  ): SeamEvidence {
    return evaluateSeams(
      profiles.smoothedRows,
      cuts,
      rows,
      profiles.rowThreshold,
      config
    );
  }

  /** P1 ∧ P2, the conjunction the candidate filter applies. */
  export function seamsPass(evidence: SeamEvidence): boolean {
    return evidence.vacuous || (evidence.significant && evidence.separated);
  }