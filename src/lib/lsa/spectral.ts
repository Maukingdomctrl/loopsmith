/**
 * LSA v1.0 — §B.7: separating jitter from intended global motion.
 *
 * CONSTRAINT 6 LIVES HERE AND NOWHERE ELSE. Fact 2 of the paper is blunt:
 * jitter τ_i and intended rigid motion β_i enter the pixel data only through
 * their SUM, so no function of the pixels can separate them. Separation
 * requires an extra prior, and the only prior available that does not name a
 * reference frame is a prior on the TEMPORAL SPECTRUM. Hence "preserve
 * intentional motion" is not a property of the pixel stage or of the solver —
 * it is one matrix multiply at the very end.
 *
 * WHY CIRCULANT IS FORCED, not chosen: any linear operator on ℝ^N commuting
 * with the cyclic shift σ is a circulant (σ has distinct eigenvalues with
 * eigenvectors φ_k; commuting operators share eigenvectors). Requiring Π
 * idempotent and symmetric forces its eigenvalues into {0,1}. So
 *     Π = I − Σ_{k∈𝒫} φ_k φ_k*,   𝒫 = −𝒫 (Π real),  0 ∈ 𝒫
 * is the ONLY admissible shape (B.27). Rotating which sprite cell is "first"
 * then maps t ↦ σt and c ↦ σc: the stabilized animation is identical, which is
 * the precise sense in which the operation is reference-free.
 *
 * GAUGE FIXING AND JITTER REMOVAL ARE THE SAME OPERATION at different cutoffs:
 * 𝒫 = {0} removes only the DC/gauge term and gives c = −t̂ (since the gauge
 * already forces T̂₀ = 0); 𝒫 ⊇ {±1} additionally preserves a bounce.
 *
 * CALIBRATION (B.29). Under H₀ (all of t̂ is iid zero-mean jitter), the
 * periodogram is flat and, per bin, P_k = |T̂_k,x|² + |T̂_k,y|² has four
 * degrees of freedom: real and imaginary parts of two independent axes, each
 * ~N(0, σ²/2). So P_k ~ (σ²/2)·χ²₄ and E[P_k] = 2σ². We estimate the white
 * floor from the upper half of the spectrum (which intended motion cannot
 * occupy), debias the median through med(χ²₄) = 3.3567, and test
 *     G_k = P_k · med(χ²₄) / ν̂  ~ χ²₄
 * against the Bonferroni-corrected upper quantile. A low harmonic is declared
 * "intended" ONLY if it is statistically inconsistent with placement jitter.
 */

import {
  CHI2_4_MEDIAN,
  WHITE_FLOOR_CUTOFF,
} from "./constants";
import { bitmapVector } from "./coords";
import { chi2Quantile4, median } from "./linalg";
import type {
  SpectralDecision,
  SpectralPolicy,
  TranslationVector,
} from "./types";

/** Below this length the periodogram has too few bins for a meaningful white
 *  floor, so the paper's fallback applies: 𝒫 = {0}, i.e. plain gauge removal. */
const MIN_FRAMES_FOR_SPECTRAL_TEST = 8;

interface Dft {
  re: Float64Array; // [k][axis] flattened: 2k = x, 2k+1 = y
  im: Float64Array;
  power: Float64Array; // P_k
}

/**
 * Per-axis cyclic DFT with the 1/√N convention of (B.28).
 *
 * DIRECT O(N²), deliberately: N ≤ 64, so an FFT saves microseconds while
 * introducing butterfly-order-dependent rounding. Determinism costs nothing
 * here and buys reproducibility (§1.3 invariant 3).
 */
function forwardDft(offsets: readonly TranslationVector[]): Dft {
  const N = offsets.length;
  const re = new Float64Array(2 * N);
  const im = new Float64Array(2 * N);
  const power = new Float64Array(N);
  const scale = 1 / Math.sqrt(N);

  for (let k = 0; k < N; k++) {
    let rx = 0;
    let ix = 0;
    let ry = 0;
    let iy = 0;
    for (let i = 0; i < N; i++) {
      const ang = (-2 * Math.PI * k * i) / N;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      rx += offsets[i].dx * c;
      ix += offsets[i].dx * s;
      ry += offsets[i].dy * c;
      iy += offsets[i].dy * s;
    }
    re[2 * k] = rx * scale;
    im[2 * k] = ix * scale;
    re[2 * k + 1] = ry * scale;
    im[2 * k + 1] = iy * scale;
    power[k] =
      re[2 * k] * re[2 * k] +
      im[2 * k] * im[2 * k] +
      re[2 * k + 1] * re[2 * k + 1] +
      im[2 * k + 1] * im[2 * k + 1];
  }
  return { re, im, power };
}

/** Inverse DFT of the retained (jitter) spectrum, negated: c = −Π t̂ (A.4). */
function inverseDftNegated(
  dft: Dft,
  keepFraction: readonly number[],
  N: number
): TranslationVector[] {
  const scale = 1 / Math.sqrt(N);
  const out: TranslationVector[] = [];

  for (let i = 0; i < N; i++) {
    let cx = 0;
    let cy = 0;
    for (let k = 0; k < N; k++) {
      // Π multiplier is (1 − η_k): η_k = 1 ⇒ harmonic fully preserved ⇒ no
      // correction applied at that frequency.
      const w = 1 - keepFraction[k];
      if (w === 0) continue;
      const ang = (2 * Math.PI * k * i) / N;
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      cx += w * (dft.re[2 * k] * c - dft.im[2 * k] * s);
      cy += w * (dft.re[2 * k + 1] * c - dft.im[2 * k + 1] * s);
    }
    out.push(bitmapVector(-cx * scale, -cy * scale));
  }
  return out;
}

export interface SpectralResult {
  /** c_i — the deliverable of (A.4), bitmap space. */
  readonly corrections: readonly TranslationVector[];
  readonly decision: SpectralDecision;
}

export function applySpectralSeparation(
  offsets: readonly TranslationVector[],
  policy: SpectralPolicy
): SpectralResult {
  const N = offsets.length;
  const dft = forwardDft(offsets);

  // η_k ∈ [0,1]: the fraction of harmonic k classified as INTENDED motion.
  const keep = new Float64Array(N);
  keep[0] = 1; // 0 ∈ 𝒫 always: DC is the gauge, never a correction (B.27).

  const gStats = new Map<number, number>();
  const preserved: number[] = [0];

  // White floor ν̂ from |k| > N/4 — the band intended motion cannot occupy.
  const floorBins: number[] = [];
  const cutoff = Math.max(1, Math.floor(WHITE_FLOOR_CUTOFF * N));
  for (let k = 1; k < N; k++) {
    const kk = Math.min(k, N - k);
    if (kk > cutoff) floorBins.push(dft.power[k]);
  }
  const whiteFloor =
    floorBins.length > 0
      ? median(Float64Array.from(floorBins), floorBins.length)
      : 0;

  const maxK = Math.max(0, Math.min(policy.maxHarmonic, Math.floor(N / 2)));
  const tested: number[] = [];
  for (let k = 1; k <= maxK; k++) tested.push(k);

  const criticalValue =
    tested.length > 0
      ? chi2Quantile4(1 - policy.alpha / tested.length) // Bonferroni (B.29)
      : Number.POSITIVE_INFINITY;

  const testable =
    policy.mode !== "off" &&
    N >= MIN_FRAMES_FOR_SPECTRAL_TEST &&
    whiteFloor > 0 &&
    tested.length > 0;

  if (testable) {
    // E[P_k] = 2σ² under H₀; med(P_k) = (σ²/2)·med(χ²₄).
    const noiseMean = (2 * whiteFloor * 2) / CHI2_4_MEDIAN / 2; // = 2σ̂²/2·2 → 2σ̂²
    for (const k of tested) {
      const p = dft.power[k];
      const g = (p * CHI2_4_MEDIAN) / whiteFloor; // ~χ²₄ under H₀
      gStats.set(k, g);

      let eta = 0;
      if (policy.mode === "hard") {
        eta = g > criticalValue ? 1 : 0;
      } else {
        // Wiener/MMSE shrinkage under the same two-component model. Restricted
        // to |k| ≤ maxHarmonic on purpose: applying it broadband would
        // partially PRESERVE jitter, which defeats the operation.
        eta = Math.max(0, 1 - noiseMean / Math.max(p, Number.MIN_VALUE));
      }

      if (eta > 0) {
        keep[k] = eta;
        keep[(N - k) % N] = eta; // 𝒫 = −𝒫 keeps Π real (B.27)
        if (eta >= 1) {
          preserved.push(k, (N - k) % N);
        }
      }
    }
  }

  const corrections = inverseDftNegated(dft, Array.from(keep), N);

  let totalEnergy = 0;
  let preservedEnergy = 0;
  for (let k = 0; k < N; k++) {
    totalEnergy += dft.power[k];
    preservedEnergy += keep[k] * keep[k] * dft.power[k];
  }

  const decision: SpectralDecision = {
    periodogram: Array.from(dft.power),
    whiteFloor,
    gStatistics: gStats,
    criticalValue,
    preservedHarmonics: Array.from(new Set(preserved)).sort((a, b) => a - b),
    shrinkage: Array.from(keep),
    preservedEnergyFraction:
      totalEnergy > 0 ? preservedEnergy / totalEnergy : 0,
  };

  return { corrections, decision };
}
