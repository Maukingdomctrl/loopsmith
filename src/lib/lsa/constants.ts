/**
 * LSA v1.0 — every numeric constant in the engine, each tagged with the
 * equation that fixes it.
 *
 * Rule 2 ("no heuristics unless mathematically justified") is auditable only if
 * there is exactly one file to audit. Nothing outside this module may contain a
 * bare numeric tuning value. A reviewer diffing this file against §B of the
 * paper can certify compliance without reading a single algorithm.
 */

import type { SpectralPolicy, StabilizeOptions } from "./types";

/* ---------- Problem size (Constraint 4) ---------- */

export const MIN_FRAMES = 2;
export const MAX_FRAMES = 64;

/* ---------- Signal stage (§B.1–B.2) ---------- */

/** σ of the isotropic Gaussian prefilter K_σ (B.2). Widens the Taylor basin. */
export const PREFILTER_SIGMA = 1.2;

/** Kernel truncation radius: ⌈3σ⌉ captures >99.7% of the mass. */
export const PREFILTER_RADIUS_SIGMAS = 3;

/** Rec.709 luminance weights used in (B.1). */
export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

/** α below this counts as unoccupied when computing supportBox (§C.5). */
export const ALPHA_EPSILON = 1 / 255;

/** Floor on the pooled RMS gradient scale s_c, to keep (B.1) finite on flat art. */
export const NORM_SCALE_FLOOR = 1e-6;

/** Pyramid depth. Level 1 seeds the integer search (§D); level 0 refines. */
export const PYRAMID_LEVELS = 2;

/* ---------- Pairwise stage (§B.2) ---------- */

/** Δ in 𝒰 = [−Δ,Δ]² — the jitter prior of §A.3.8 (observed jitter is 1–3 px). */
export const SEARCH_RADIUS = 4;

/** Local integer window at level 0 around the upscaled level-1 winner. */
export const FINE_INTEGER_RADIUS = 1;

/** Termination on ‖M⁻¹q‖_∞, in pixels (§B.2 Step 5). */
export const SUBPIXEL_TOL = 1e-3;

/** Gauss–Newton iterations per κ stage (§B.2 Step 5). Bounded ⇒ deterministic. */
export const IRLS_MAX_ITERS = 5;

/** Minimum mutual-support mass Σ m_ij for a pair to be measurable (§C.4). */
export const MIN_SUPPORT_MASS = 16;

/** λ_min(A_ij) below this ⇒ "degenerate-information" (B.12). */
export const MIN_INFORMATION_EIGENVALUE = 1e-9;

/** Numerical floor on σ̂²_ij (B.14): a perfect match must not yield A = ∞. */
export const SIGMA_SQ_FLOOR = 1e-10;

/* ---------- Robust loss (§B.3) ---------- */

/** MAD → σ consistency factor for the normal distribution (B.18). */
export const MAD_CONSISTENCY = 1.4826;

/** Tukey biweight tuning for 95% Gaussian efficiency (B.18): κ = 4.685·ŝ. */
export const TUKEY_K = 4.685;

/** Geman–McClure tuning, matched to Tukey's 95%-efficiency scale. */
export const GEMAN_MCCLURE_K = 4.685;

/**
 * Graduated-non-convexity schedule, as multiples of the base κ (§B.3).
 * The first stage is effectively quadratic (convex) and seeds the rest; the
 * homotopy changes the path, never the objective.
 */
export const KAPPA_SCHEDULE: readonly number[] = [4, 2, 1];

/** Floor on ŝ so that κ > 0 on a pixel-exact match. */
export const MAD_FLOOR = 1e-6;

/* ---------- Graph stage (§B.4) ---------- */

/** 99.9% quantile of χ²₂ = −2·ln(0.001). Computed, not tabled (B.4.3). */
export const CURL_REJECTION_P = 0.999;

/* ---------- Solver (§B.5–B.6) ---------- */

/** λ = TIKHONOV_RATIO · tr(𝓛)/N — unconditional nonsingularity (§B.4.2). */
export const TIKHONOV_RATIO = 1e-6;

/** Cyclic-Jacobi off-diagonal tolerance and sweep cap (eigenvalue diagnostics). */
export const JACOBI_TOL = 1e-14;
export const JACOBI_MAX_SWEEPS = 64;

/* ---------- Spectral stage (§B.7) ---------- */

/** Family-wise significance for the harmonic test (B.29). */
export const FISHER_G_ALPHA = 0.01;

/** Largest |k| eligible for 𝒫: intended body motion is low-order (§B.7). */
export const MAX_HARMONIC = 2;

/** Median of χ²₄, used to debias ν̂ into a variance estimate (§B.7). */
export const CHI2_4_MEDIAN = 3.356694;

/** Fraction of the spectrum treated as the white jitter floor: |k| > N/4 (B.29). */
export const WHITE_FLOOR_CUTOFF = 0.25;

/* ---------- Defaults ---------- */

export const DEFAULT_SPECTRAL_POLICY: SpectralPolicy = {
  mode: "hard",
  maxHarmonic: MAX_HARMONIC,
  alpha: FISHER_G_ALPHA,
};

export const DEFAULT_OPTIONS: StabilizeOptions = {
  searchRadius: SEARCH_RADIUS,
  prefilterSigma: PREFILTER_SIGMA,
  robustLoss: "tukey",
  spectral: DEFAULT_SPECTRAL_POLICY,
  enableCurlRejection: true,
  edgeTopology: "dyadic",
  quantizeOutput: false,
};

/**
 * Stable fingerprint of the constant set + effective options.
 * Written into RunProvenance so the regression suite can assert
 * "same input hashes + same fingerprint ⇒ byte-identical translations" (§1.3).
 */
export function constantsFingerprint(options: StabilizeOptions): string {
  const parts = [
    "LSA-1.0",
    PREFILTER_SIGMA,
    PREFILTER_RADIUS_SIGMAS,
    LUMA_R,
    LUMA_G,
    LUMA_B,
    ALPHA_EPSILON,
    NORM_SCALE_FLOOR,
    PYRAMID_LEVELS,
    SEARCH_RADIUS,
    FINE_INTEGER_RADIUS,
    SUBPIXEL_TOL,
    IRLS_MAX_ITERS,
    MIN_SUPPORT_MASS,
    MIN_INFORMATION_EIGENVALUE,
    SIGMA_SQ_FLOOR,
    MAD_CONSISTENCY,
    TUKEY_K,
    GEMAN_MCCLURE_K,
    KAPPA_SCHEDULE.join(","),
    MAD_FLOOR,
    CURL_REJECTION_P,
    TIKHONOV_RATIO,
    FISHER_G_ALPHA,
    MAX_HARMONIC,
    CHI2_4_MEDIAN,
    WHITE_FLOOR_CUTOFF,
    options.searchRadius,
    options.prefilterSigma,
    options.robustLoss,
    options.spectral.mode,
    options.spectral.maxHarmonic,
    options.spectral.alpha,
    String(options.enableCurlRejection),
    options.edgeTopology,
    String(options.quantizeOutput),
  ];

  // FNV-1a over the joined description; identical algorithm to hash.ts, kept
  // local so constants.ts stays dependency-free.
  let h = 0x811c9dc5;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
