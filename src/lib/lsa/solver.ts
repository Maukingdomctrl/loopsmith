/**
 * LSA v1.0 — §B.5–B.6: assemble 𝓛 and b, gauge-fix, solve.
 *
 * The proven core, and the module least likely to ever change. Its API takes an
 * already-weighted graph and returns a vector: no pixels, no images, no frames.
 * That is what makes it testable against hand-computed 3- and 4-node examples
 * with exact rational answers — including the single best regression test in
 * the suite, Corollary B.8's prediction that on a bare ring the residual is
 * EXACTLY −curl/N on every edge INCLUDING the seam. Any accidental
 * reference-frame bias fails that test immediately.
 *
 * ASSEMBLY (B.23)–(B.24):
 *     𝓛_ii = Σ_{j∼i} A_ij ,   𝓛_ij = −A_ij
 *     b_i  = Σ_{j:(i→j)} A_ij d_ij − Σ_{j:(j→i)} A_ji d_ji
 * b is a DIVERGENCE: node i's signed, information-weighted net measured
 * displacement. So the whole stage reads "find the potential whose gradient
 * best matches the measured edge flow" — a discrete Hodge decomposition whose
 * circulation part is irreducible measurement error (Theorem B.6).
 *
 * GAUGE (B.26): instead of forming a pseudoinverse we solve
 *     (𝓛 + Σ_K (1/|K|)·𝟙_K𝟙_Kᵀ⊗I₂ + λΠ₀) t = b
 * which is symmetric POSITIVE DEFINITE, so the runtime path is a plain
 * Cholesky: no rank detection, no pivoting, no iterative tolerance — nothing
 * nondeterministic. Why this returns 𝓛⁺b: the gauge term vanishes on 𝒩⊥ and
 * acts as the identity on 𝒩 = span{𝟙_K ⊗ v}, while 𝓛 vanishes on 𝒩 and is
 * invertible on 𝒩⊥. The operator is block diagonal w.r.t. 𝒩 ⊕ 𝒩⊥, and since
 * b ∈ 𝒩⊥ (Theorem A.1(iii)) the solution lands in 𝒩⊥ — i.e. it satisfies
 * Σ_i t̂_i = 0 per component (A.3).
 *
 * The Tikhonov projector is the DEFAULT mean-removal projector Π₀ (𝒫 = {0}),
 * not the spectral Π of §B.7. Using the latter would be circular: 𝒫 is chosen
 * from t̂, which does not exist yet. Π₀ satisfies the only property §A.5
 * extension 3 needs (Π𝟙 = 0, so ker 𝓛 is unchanged), so uniqueness survives.
 */

import { bitmapVector } from "./coords";
import {
  choleskyFactor,
  choleskyInverse,
  choleskySolve,
  jacobiEigenvalues,
  sym2,
} from "./linalg";
import { tikhonovLambda, totalInformationTrace } from "./weights";
import type {
  ConstraintGraph,
  SolverSolution,
  SolverStatistics,
  SymMat2,
  TranslationVector,
  WeightedEdge,
} from "./types";

/**
 * Diagnostic budget, not a mathematical constant, hence local. Dense Jacobi is
 * O(n³·sweeps) with n = 2N: at N ≤ 32 that is ~7 Mflop (sub-millisecond); at
 * N = 64 it approaches the cost of the entire pairwise stage. Above the cap the
 * two eigenvalue statistics report NaN and every other diagnostic stays exact.
 */
export const EIGEN_DIAGNOSTIC_MAX_DIM = 64;

export interface SolveResult extends SolverSolution {
  /** Diagonal blocks of 𝓛⁺ (Lemma B.5). Same objects as `covariances`. */
  readonly pseudoInverseDiagonal: readonly SymMat2[];
  /** Full 𝓛⁺, dense 2N×2N row-major, for effective-resistance queries. */
  readonly pseudoInverse: Float64Array;
}

export function solveTranslations(
  graph: ConstraintGraph,
  edges: readonly WeightedEdge[]
): SolveResult {
  const N = graph.frameCount;
  const n = 2 * N;

  const L = new Float64Array(n * n); // bare 𝓛, retained for eigen-diagnostics
  const b = new Float64Array(n);

  const admitted = edges.filter((e) => e.admitted);

  const put = (r: number, c: number, v: number): void => {
    L[r * n + c] += v;
  };

  // ---- (B.23) and (B.24), traversed in canonical edge order ----
  for (const e of admitted) {
    const i = e.edge.from;
    const j = e.edge.to;
    const A = e.information;

    const ix = 2 * i;
    const iy = 2 * i + 1;
    const jx = 2 * j;
    const jy = 2 * j + 1;

    // 𝓛_ii += A ; 𝓛_jj += A
    put(ix, ix, A.xx); put(ix, iy, A.xy); put(iy, ix, A.xy); put(iy, iy, A.yy);
    put(jx, jx, A.xx); put(jx, jy, A.xy); put(jy, jx, A.xy); put(jy, jy, A.yy);

    // 𝓛_ij = 𝓛_ji = −A
    put(ix, jx, -A.xx); put(ix, jy, -A.xy); put(iy, jx, -A.xy); put(iy, jy, -A.yy);
    put(jx, ix, -A.xx); put(jx, iy, -A.xy); put(jy, ix, -A.xy); put(jy, iy, -A.yy);

    // b_i += A·d_ij ; b_j −= A·d_ij
    const dx = e.displacement.dx;
    const dy = e.displacement.dy;
    const ax = A.xx * dx + A.xy * dy;
    const ay = A.xy * dx + A.yy * dy;
    b[ix] += ax;
    b[iy] += ay;
    b[jx] -= ax;
    b[jy] -= ay;
  }

  // ---- consistency: 𝟙_Kᵀ b = 0 per component (Theorem A.1(iii)) ----
  // Always true in exact arithmetic, because each row of B has one +1 and one
  // −1. A violation can therefore only be an ASSEMBLY BUG — the cheapest
  // possible correctness alarm, and the reason it is checked every run.
  const componentOf = new Map<number, number>();
  graph.components.forEach((comp, k) =>
    comp.forEach((i) => componentOf.set(i, k))
  );

  let consistencyResidual = 0;
  for (const comp of graph.components) {
    let sx = 0;
    let sy = 0;
    for (const i of comp) {
      sx += b[2 * i];
      sy += b[2 * i + 1];
    }
    consistencyResidual = Math.max(
      consistencyResidual,
      Math.sqrt(sx * sx + sy * sy)
    );
  }

  // ---- augmentation (B.26) + Tikhonov (§B.4.2) ----
  // tr(𝓛) = 2·Σ_e tr(A_e) because every edge contributes to both endpoints.
  const lambda = tikhonovLambda(
    2 * totalInformationTrace(admitted.map((e) => e.information)),
    N
  );

  const aug = L.slice();

  // Frames with no admitted incident edge (blank, or fully rejected) are
  // singleton components: 𝓛 block = 0, gauge term = I, b = 0 ⇒ t_i = 0 exactly.
  const singletons: number[] = [];
  for (let i = 0; i < N; i++) if (!componentOf.has(i)) singletons.push(i);

  for (const comp of graph.components) {
    const inv = 1 / comp.length;
    for (const i of comp) {
      for (const j of comp) {
        // gauge: (1/|K|)·𝟙_K𝟙_Kᵀ ⊗ I₂
        aug[2 * i * n + 2 * j] += inv;
        aug[(2 * i + 1) * n + 2 * j + 1] += inv;
        // Tikhonov: λ·Π₀|_K = λ(I_K − (1/|K|)𝟙_K𝟙_Kᵀ) ⊗ I₂
        const pi = (i === j ? 1 : 0) - inv;
        aug[2 * i * n + 2 * j] += lambda * pi;
        aug[(2 * i + 1) * n + 2 * j + 1] += lambda * pi;
      }
    }
  }
  for (const i of singletons) {
    aug[2 * i * n + 2 * i] += 1;
    aug[(2 * i + 1) * n + 2 * i + 1] += 1;
  }

  // ---- solve ----
  const factor = aug.slice();
  const ok = choleskyFactor(factor, n);

  const t = ok ? choleskySolve(factor, n, b) : new Float64Array(n);
  const inverse = ok ? choleskyInverse(factor, n) : new Float64Array(n * n);

  // ---- recover 𝓛⁺ from the augmented inverse ----
  // inv(𝓛 + G + λΠ₀) acts as G⁻¹ = I on 𝒩 and as ≈𝓛⁺ on 𝒩⊥, so subtracting
  // the 𝒩 projector leaves 𝓛⁺ (Lemma B.5).
  const pinv = inverse.slice();
  for (const comp of graph.components) {
    const inv = 1 / comp.length;
    for (const i of comp) {
      for (const j of comp) {
        pinv[2 * i * n + 2 * j] -= inv;
        pinv[(2 * i + 1) * n + 2 * j + 1] -= inv;
      }
    }
  }
  for (const i of singletons) {
    pinv[2 * i * n + 2 * i] -= 1;
    pinv[(2 * i + 1) * n + 2 * i + 1] -= 1;
  }


const offsets: TranslationVector[] = [];
const covariances: SymMat2[] = [];

for (let i = 0; i < N; i++) {
  offsets.push(bitmapVector(t[2 * i], t[2 * i + 1]));

  covariances.push(
    sym2(
      Math.max(0, pinv[2 * i * n + 2 * i]),
      pinv[2 * i * n + 2 * i + 1],
      Math.max(0, pinv[(2 * i + 1) * n + 2 * i + 1])
    )
  );
}

  // ---- residuals, objective, loop closure ----
  const edgeResiduals: TranslationVector[] = [];
  let objective = 0;
  for (const e of edges) {
    if (!e.admitted) {
      edgeResiduals.push(bitmapVector(0, 0));
      continue;
    }
    const i = e.edge.from;
    const j = e.edge.to;
    const rx = t[2 * i] - t[2 * j] - e.displacement.dx;
    const ry = t[2 * i + 1] - t[2 * j + 1] - e.displacement.dy;
    edgeResiduals.push(bitmapVector(rx, ry));

    const A = e.information;
    objective += A.xx * rx * rx + 2 * A.xy * rx * ry + A.yy * ry * ry;
  }

  // Σ_i d_{i,i+1} around the loop, oriented forward. This is the curl of the
  // ring cycle: the quantity Corollary B.8 spreads as −curl/N over all N edges.
  let closureX = 0;
  let closureY = 0;
  for (const e of edges) {
    if (!e.admitted || !e.edge.isRingEdge) continue;
    const forward = (e.edge.to - e.edge.from + N) % N === 1 ? 1 : -1;
    closureX += forward * e.displacement.dx;
    closureY += forward * e.displacement.dy;
  }

  let gx = 0;
  let gy = 0;
  for (let i = 0; i < N; i++) {
    gx += t[2 * i];
    gy += t[2 * i + 1];
  }

  // ---- eigen-diagnostics (gated) ----
  let lambdaMinOnGaugeSlice = Number.NaN;
  let conditionNumber = Number.NaN;
  if (n <= EIGEN_DIAGNOSTIC_MAX_DIM) {
    const evL = jacobiEigenvalues(L, n);
    const gaugeDim = 2 * (graph.components.length + singletons.length);
    lambdaMinOnGaugeSlice = gaugeDim < n ? evL[gaugeDim] : Number.NaN;

    const evAug = jacobiEigenvalues(aug, n);
    const lo = evAug[0];
    const hi = evAug[n - 1];
    conditionNumber = lo > 0 ? hi / lo : Number.POSITIVE_INFINITY;
  }

  // ---- effective resistance (Lemma B.5) ----
  // Var(t̂_i − t̂_j) = (e_i − e_j)ᵀ𝓛⁺(e_i − e_j) = R_eff(i,j). This is the number
  // that justifies the dyadic edge set: O(log N) here vs O(N) on a bare ring.
  let maxEffectiveResistance = 0;
  for (const comp of graph.components) {
    for (let a = 0; a < comp.length; a++) {
      for (let c = a + 1; c < comp.length; c++) {
        const i = comp[a];
        const j = comp[c];
        const rx =
          pinv[2 * i * n + 2 * i] +
          pinv[2 * j * n + 2 * j] -
          2 * pinv[2 * i * n + 2 * j];
        const ry =
          pinv[(2 * i + 1) * n + 2 * i + 1] +
          pinv[(2 * j + 1) * n + 2 * j + 1] -
          2 * pinv[(2 * i + 1) * n + 2 * j + 1];
        const r = 0.5 * (rx + ry); // averaged over axes
        if (r > maxEffectiveResistance) maxEffectiveResistance = r;
      }
    }
  }

  const statistics: SolverStatistics = {
    objectiveValue: objective,
    edgeResiduals,
    loopClosure: bitmapVector(closureX, closureY),
    lambdaMinOnGaugeSlice,
    conditionNumber,
    tikhonov: lambda,
    maxEffectiveResistance,
    consistencyResidual,
    gaugeResidual: Math.sqrt(gx * gx + gy * gy),
    admittedEdgeCount: admitted.length,
    rejectedEdgeCount: edges.length - admitted.length,
    componentCount: graph.components.length + singletons.length,
    choleskySucceeded: ok,
  };

  return {
    offsets,
    covariances,
    statistics,
    pseudoInverseDiagonal: covariances,
    pseudoInverse: pinv,
  };
}
