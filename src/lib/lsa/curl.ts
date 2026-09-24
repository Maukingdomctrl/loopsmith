/**
 * LSA v1.0 — §B.4.3: calibrated edge rejection by cycle consistency.
 *
 * This is the ONLY module in the engine that makes a discrete accept/reject
 * decision, and it makes it by a likelihood-ratio criterion rather than by a
 * threshold on pixel differences. Isolating it means the single branch in an
 * otherwise branch-free numeric pipeline is auditable, loggable, and
 * switchable off (enableCurlRejection) so results can be compared with and
 * without it.
 *
 * WHY THIS WORKS AT ALL: by (A.5), for any cycle γ the true offsets satisfy
 * z_γᵀBτ = 0 identically (a telescoping sum). Hence curl_γ(d) = z_γᵀd depends
 * on NO UNKNOWN and vanishes iff the measurements on γ are mutually consistent.
 * It is a pure error functional, available before any solve — which is why this
 * stage needs no fixed-point iteration with the solver.
 *
 * PROTECTED RING EDGES: rejecting an ℓ=1 edge could disconnect the graph and
 * destroy the uniqueness hypothesis of Theorem A.1. So a bad ring edge is
 * instead TEMPERED — its information is scaled by 13.8/χ̄² — which preserves
 * connectivity while removing the bad measurement's leverage.
 */

import { CURL_REJECTION_P } from "./constants";
import { bitmapVector } from "./coords";
import {
  chi2Quantile2,
  median,
  sym2Add,
  sym2Inverse,
  sym2Quadratic,
  SYM2_ZERO,
} from "./linalg";
import type {
  ConstraintGraph,
  CurlResidual,
  EdgeRejectionReason,
  PairwiseConstraint,
  WeightedEdge,
} from "./types";

/** 99.9% quantile of χ²₂ — computed, not tabled, so the calibration can't rot. */
export const CURL_THRESHOLD = chi2Quantile2(CURL_REJECTION_P);

/**
 * curl_γ(d) = z_γᵀd, its covariance Σ_γ = Σ_{e∈γ} A_e⁻¹, and
 * χ²_γ = curlᵀΣ_γ⁻¹curl ~ χ²₂ (B.20).
 *
 * Lemma B.7: linearity of the telescoping identity kills the signal;
 * independence of edge errors sums the covariances; a quadratic form in a
 * standard bivariate normal is χ²₂.
 */
export function computeCurls(
  graph: ConstraintGraph,
  constraints: readonly PairwiseConstraint[]
): CurlResidual[] {
  const out: CurlResidual[] = [];

  for (const cycle of graph.cycleBasis) {
    let cx = 0;
    let cy = 0;
    let cov = SYM2_ZERO;
    let usable = true;

    for (let k = 0; k < cycle.edgeIds.length; k++) {
      const c = constraints[cycle.edgeIds[k]];
      if (!c || c.failure) {
        usable = false;
        break;
      }
      const s = cycle.signs[k];
      cx += s * c.displacement.dx;
      cy += s * c.displacement.dy;

      const inv = sym2Inverse(c.information);
      if (!inv) {
        usable = false;
        break;
      }
      cov = sym2Add(cov, inv);
    }
    if (!usable) continue;

    const covInv = sym2Inverse(cov);
    const chiSquared = covInv ? sym2Quadratic(covInv, cx, cy) : 0;

    out.push({
      cycle,
      curl: bitmapVector(cx, cy),
      covariance: cov,
      chiSquared,
    });
  }
  return out;
}

/**
 * Turn measured constraints + curl statistics into the weighted edge set the
 * solver consumes.
 *
 * Decision table, in order of precedence:
 *   pairwise failure            → reject with that reason
 *   clamped to the prior box 𝒰  → reject (the measurement violated the prior)
 *   median χ² > 13.816, ℓ > 1   → reject ("curl-inconsistent")
 *   median χ² > 13.816, ℓ = 1   → ADMIT with A scaled by 13.816/χ̄² (protected)
 *   otherwise                   → admit unmodified
 */
export function buildWeightedEdges(
  graph: ConstraintGraph,
  constraints: readonly PairwiseConstraint[],
  curls: readonly CurlResidual[],
  enableRejection: boolean
): WeightedEdge[] {
  // Gather each edge's χ² samples across the cycles containing it.
  const perEdge: number[][] = graph.edges.map(() => []);
  for (const c of curls) {
    for (const id of c.cycle.edgeIds) {
      if (perEdge[id]) perEdge[id].push(c.chiSquared);
    }
  }

  return graph.edges.map((edge) => {
    const constraint = constraints[edge.id];

    if (!constraint || constraint.failure) {
      return {
        edge,
        displacement: bitmapVector(0, 0),
        information: SYM2_ZERO,
        informationScale: 0,
        medianChiSquared: Number.NaN,
        admitted: false,
        rejectionReason: constraint?.failure ?? "blank-frame",
      };
    }

    const samples = perEdge[edge.id];
    const medChi =
      samples.length > 0
        ? median(Float64Array.from(samples), samples.length)
        : Number.NaN;

    let reason: EdgeRejectionReason | null = null;
    let scale = 1;

    if (enableRejection && constraint.clampedToPrior && !edge.isRingEdge) {
      reason = "clamped-to-prior";
    } else if (
      enableRejection &&
      Number.isFinite(medChi) &&
      medChi > CURL_THRESHOLD
    ) {
      if (edge.isRingEdge) {
        // Temper, never remove: connectivity ⇒ uniqueness (Theorem A.1).
        scale = CURL_THRESHOLD / medChi;
      } else {
        reason = "curl-inconsistent";
      }
    }

    const admitted = reason === null;
    return {
      edge,
      displacement: constraint.displacement,
      information: admitted
        ? {
            xx: constraint.information.xx * scale,
            xy: constraint.information.xy * scale,
            yy: constraint.information.yy * scale,
          }
        : SYM2_ZERO,
      informationScale: admitted ? scale : 0,
      medianChiSquared: medChi,
      admitted,
      rejectionReason: reason,
    };
  });
}
