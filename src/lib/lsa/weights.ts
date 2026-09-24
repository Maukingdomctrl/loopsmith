/**
 * LSA v1.0 — (B.13)–(B.14): from accumulated sums to the information matrix.
 *
 * This module exists to make edge weighting UNTUNABLE. (B.14) is the paper's
 * load-bearing anti-heuristic result: A_ij = M / σ̂² is the inverse covariance
 * of the very measurement it weights, and Theorem B.10 (BLUE) holds precisely
 * BECAUSE the weight equals that inverse covariance. Weight choice is not a
 * knob; it is the hypothesis of an optimality theorem.
 *
 * Accordingly there is no parameter here to inject a hand-chosen weight
 * through, and there is no pixel loop either — the module is pure algebra over
 * sums produced elsewhere. Three properties then come for free:
 *
 *   • an edge between genuinely different frames (a blink, a big pose change)
 *     has large σ̂² ⇒ small A ⇒ automatically discounted;
 *   • an edge over weak texture has small M ⇒ small A;
 *   • an edge informative in x but not y has ANISOTROPIC A, and Stage 2 uses it
 *     only where it is informative. A scalar weight cannot express that, which
 *     is why (A.2) is written with matrix weights.
 */

import {
  MIN_INFORMATION_EIGENVALUE,
  SIGMA_SQ_FLOOR,
  TIKHONOV_RATIO,
} from "./constants";
import { sym2ClampPsd, sym2Scale, sym2Spectrum, sym2Trace } from "./linalg";
import type { Mat2Spectrum, SymMat2 } from "./types";

/** Number of channels C in f_i: premultiplied alpha + premultiplied luma. */
export const CHANNEL_COUNT = 2;

/**
 * σ̂²_ij — (B.14).
 *
 *     σ̂² = Σ m w Σ_c Δ_c²  /  (C · Σ m w − 2)
 *
 * The −2 is the degrees-of-freedom correction for the two estimated
 * translation components; without it σ̂² is biased low on small supports and
 * the edge is over-trusted. Floored at SIGMA_SQ_FLOOR so a pixel-exact match
 * yields a large-but-finite A rather than ∞.
 */
export function residualVariance(
  weightedSquaredResidual: number,
  effectiveSampleCount: number
): number {
  const dof = CHANNEL_COUNT * effectiveSampleCount - 2;
  if (!(dof > 0)) return Number.POSITIVE_INFINITY;
  return Math.max(SIGMA_SQ_FLOOR, weightedSquaredResidual / dof);
}

/** A_ij = M / σ̂² — (B.14). PSD-clamped against accumulation round-off. */
export function informationMatrix(
  structureTensor: SymMat2,
  sigmaSq: number
): SymMat2 {
  if (!Number.isFinite(sigmaSq) || !(sigmaSq > 0)) {
    return { xx: 0, xy: 0, yy: 0 };
  }
  return sym2ClampPsd(sym2Scale(structureTensor, 1 / sigmaSq));
}

/** Eigenstructure of A_ij; `lambdaMin ≈ 0` IS the aperture problem (B.12). */
export function informationSpectrum(a: SymMat2): Mat2Spectrum {
  return sym2Spectrum(a);
}

/** λ_min(A) below this ⇒ the edge constrains nothing in at least one direction. */
export function isDegenerate(spectrum: Mat2Spectrum): boolean {
  return !(spectrum.lambdaMax > MIN_INFORMATION_EIGENVALUE);
}

/**
 * λ = TIKHONOV_RATIO · tr(𝓛)/N — §B.4.2.
 *
 * Scaled by tr(𝓛)/N rather than being an absolute constant so that it is
 * invariant to the overall magnitude of the information matrices (which depends
 * on image contrast and on |Ω|). It makes the system unconditionally
 * nonsingular and biases only the null directions, by at most λ/λ_min in the
 * informative ones.
 */
export function tikhonovLambda(
  laplacianTrace: number,
  frameCount: number
): number {
  if (frameCount <= 0) return 0;
  return (TIKHONOV_RATIO * laplacianTrace) / frameCount;
}

/** Σ over admitted edges of tr(A_e), used for the λ scale above. */
export function totalInformationTrace(
  informations: readonly SymMat2[]
): number {
  let t = 0;
  for (const a of informations) t += sym2Trace(a);
  return t;
}
