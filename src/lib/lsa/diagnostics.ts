/**
 * LSA v1.0 — §B.6 / Lemma B.5: quality reporting.
 *
 * Stabilization is invisible when it works and infuriating when it does not.
 * Without per-frame variance the UI can only say "done". With it — and
 * Lemma B.5 gives it for FREE from the same Cholesky factorization, since
 * Var(t̂_i − t̂_j) = R_eff(i,j) in the network with conductances A_e — the UI can
 * say "frame 7 has weak texture; its correction is uncertain to ±0.4 px", and
 * the user can fall back to alignMode with a reason.
 *
 * This module exists so that quality reporting never tempts anyone to compute
 * statistics inside the hot loops of pairwise.ts.
 */

import { sym2Spectrum } from "./linalg";
import { MIN_INFORMATION_EIGENVALUE } from "./constants";
import type {
  ConstraintGraph,
  FrameQuality,
  PairwiseConstraint,
  SolverSolution,
  SymMat2,
  WeightedEdge,
} from "./types";

export function buildFrameQuality(
  graph: ConstraintGraph,
  constraints: readonly PairwiseConstraint[],
  edges: readonly WeightedEdge[],
  solution: SolverSolution
): FrameQuality[] {
  const N = graph.frameCount;

  const degree = new Array<number>(N).fill(0);
  const aggregate: SymMat2[] = Array.from({ length: N }, () => ({
    xx: 0,
    xy: 0,
    yy: 0,
  }));
  const etaSum = new Array<number>(N).fill(0);
  const etaCount = new Array<number>(N).fill(0);

  for (const e of edges) {
    if (!e.admitted) continue;
    for (const i of [e.edge.from, e.edge.to]) {
      degree[i]++;
      aggregate[i] = {
        xx: aggregate[i].xx + e.information.xx,
        xy: aggregate[i].xy + e.information.xy,
        yy: aggregate[i].yy + e.information.yy,
      };
      const c = constraints[e.edge.id];
      if (c && !c.failure) {
        etaSum[i] += c.rejectedEnergyFraction;
        etaCount[i]++;
      }
    }
  }

  return Array.from({ length: N }, (_, i) => {
    // √λ_max of the frame's 𝓛⁺ block: the worst-axis ± px uncertainty.
    const cov = sym2Spectrum(solution.covariances[i]);
    const info = sym2Spectrum(aggregate[i]);
    return {
      index: i,
      degree: degree[i],
      uncertaintyPx: Math.sqrt(Math.max(0, cov.lambdaMax)),
      localMotionFraction: etaCount[i] > 0 ? etaSum[i] / etaCount[i] : 0,
      apertureLimited:
        degree[i] > 0 && !(info.lambdaMin > MIN_INFORMATION_EIGENVALUE),
    };
  });
}

/**
 * Corollary B.8 witness. On a bare ring with equal isotropic weights the
 * optimal residual is IDENTICAL on every edge, equal to −curl/N, INCLUDING the
 * wrap edge. Returns the max deviation from that prediction, which a regression
 * test asserts is ~0 for a synthetic uniform-weight ring. Any accidental
 * reference-frame bias — the thing Constraint 3 forbids — shows up here first.
 */
export function ringResidualUniformity(
  graph: ConstraintGraph,
  edges: readonly WeightedEdge[],
  solution: SolverSolution
): { predictedX: number; predictedY: number; maxDeviation: number } {
  const N = graph.frameCount;
  const ring = edges.filter((e) => e.admitted && e.edge.isRingEdge);
  if (ring.length !== N) {
    return { predictedX: Number.NaN, predictedY: Number.NaN, maxDeviation: Number.NaN };
  }

  const predictedX = -solution.statistics.loopClosure.dx / N;
  const predictedY = -solution.statistics.loopClosure.dy / N;

  let maxDeviation = 0;
  for (const e of ring) {
    const r = solution.statistics.edgeResiduals[e.edge.id];
    const forward = (e.edge.to - e.edge.from + N) % N === 1 ? 1 : -1;
    const dx = forward * r.dx - predictedX;
    const dy = forward * r.dy - predictedY;
    maxDeviation = Math.max(maxDeviation, Math.sqrt(dx * dx + dy * dy));
  }
  return { predictedX, predictedY, maxDeviation };
}
