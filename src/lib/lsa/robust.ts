/**
 * LSA v1.0 — §B.3: the robust loss, its IRLS weights, and the MAD scale.
 *
 * Isolated because Theorem C.1 (bounded — in fact exactly ZERO — influence) and
 * Lemma B.3 (IRLS is a monotone MM algorithm) are properties of φ alone, not of
 * the estimator that uses it. Lemma B.3 requires φ concave and increasing on
 * [0,∞); keeping φ in one file makes that a single-file invariant with a
 * single-file property test:
 *
 *     sample φ on a grid → assert monotone, assert concave
 *     assert w(r) === 0 for |r| > κ            (the redescending property)
 *
 * Swapping Tukey for Geman–McClure must not require touching pairwise.ts, and
 * with this boundary it does not.
 */

import {
  GEMAN_MCCLURE_K,
  KAPPA_SCHEDULE,
  MAD_CONSISTENCY,
  MAD_FLOOR,
  TUKEY_K,
} from "./constants";
import { median } from "./linalg";
import type { RobustScale } from "./types";

export type LossKind = "tukey" | "geman-mcclure";

/**
 * ρ(r) = φ(r²).
 *
 * Tukey biweight (B.16): φ(s) = (κ²/6)[1 − (1 − s/κ²)³] for s ≤ κ², else κ²/6.
 * Constant beyond κ ⇒ a pixel that has left the basin contributes a FIXED cost,
 * so its gradient contribution is exactly zero (Theorem C.1). This is what
 * excises a blink rather than merely down-weighting it.
 */
export function lossValue(kind: LossKind, r: number, kappa: number): number {
  const s = r * r;
  const k2 = kappa * kappa;
  if (kind === "tukey") {
    if (s >= k2) return k2 / 6;
    const t = 1 - s / k2;
    return (k2 / 6) * (1 - t * t * t);
  }
  // Geman–McClure: φ(s) = s / (1 + s/κ²). Concave, increasing, redescending
  // influence, but never exactly zero — hence the softer alternative.
  return s / (1 + s / k2);
}

/**
 * w(r) = 2φ′(r²) — the IRLS weight of (B.17).
 *
 * Tukey: (1 − r²/κ²)² for |r| ≤ κ, and EXACTLY 0 beyond. The hard zero is the
 * mechanism behind Theorem C.1's "∂δ̂/∂Δ(x₀) = 0 whenever |Δ(x₀)| > κ".
 */
export function lossWeight(kind: LossKind, r: number, kappa: number): number {
  const k2 = kappa * kappa;
  const s = r * r;
  if (kind === "tukey") {
    if (s >= k2) return 0;
    const t = 1 - s / k2;
    return t * t;
  }
  const d = 1 + s / k2;
  return 1 / (d * d);
}

/** Default κ multiplier for a loss kind, at the 95%-Gaussian-efficiency point. */
export function baseKappaFactor(kind: LossKind): number {
  return kind === "tukey" ? TUKEY_K : GEMAN_MCCLURE_K;
}

/**
 * MAD scale — (B.18): ŝ = 1.4826 · med|r − med r|, κ = 4.685 · ŝ.
 *
 * The MAD is used rather than an RMS because it has 50% breakdown: as long as
 * at least half the supported pixels are model-consistent (overwhelmingly true
 * for a 1–3 px jitter with one closed eye), ŝ reflects the GOOD pixels and the
 * blink therefore lands outside κ. An RMS scale would be inflated by the very
 * outliers it is supposed to detect, and the threshold would swallow them.
 *
 * `residuals` is a scratch buffer of length ≥ count, filled by the caller in a
 * fixed raster traversal; median() sorts a copy, so the result is independent
 * of engine and of input permutation (§1.3 invariant 4).
 */
export function madScale(
  residuals: Float64Array,
  count: number,
  kind: LossKind,
  kappaMultiplier: number
): RobustScale {
  if (count <= 0) {
    return {
      sHat: MAD_FLOOR,
      kappa: baseKappaFactor(kind) * MAD_FLOOR * kappaMultiplier,
      inlierFraction: 0,
      effectiveSampleCount: 0,
    };
  }

  const med = median(residuals, count);

  const dev = new Float64Array(count);
  for (let i = 0; i < count; i++) dev[i] = Math.abs(residuals[i] - med);
  const mad = median(dev, count);

  const sHat = Math.max(MAD_FLOOR, MAD_CONSISTENCY * mad);
  const kappa = baseKappaFactor(kind) * sHat * kappaMultiplier;

  let inliers = 0;
  for (let i = 0; i < count; i++) if (residuals[i] <= kappa) inliers++;

  return {
    sHat,
    kappa,
    inlierFraction: inliers / count,
    effectiveSampleCount: 0, // filled by the accumulation pass
  };
}

/**
 * The graduated-non-convexity homotopy of §B.3: κ ∈ {4ŝ, 2ŝ, κ_final}.
 *
 * The first stage is effectively quadratic, hence convex, hence has a unique
 * solution that seeds the next. The homotopy changes only the PATH taken to the
 * objective, never the objective itself — so it is a legitimate optimizer
 * detail rather than a tuning heuristic. Fixed length ⇒ deterministic.
 */
export function kappaSchedule(): readonly number[] {
  return KAPPA_SCHEDULE;
}
