/**
 * LSA v1.0 — §B.2: pairwise displacement estimation for one ordered pair.
 *
 * The only expensive module in the engine (O(|E|·P·K)) and the only one that
 * touches pixels in anger, so it is also the only sensible place to optimize.
 * Everything downstream consumes PairwiseConstraint and nothing else, which is
 * what keeps Stage 1 and Stage 2 statistically coupled but architecturally
 * separate.
 *
 * TWO STAGES, COMPLEMENTARY BY CONSTRUCTION (§B.3 closing remark):
 *
 *  Stage A — exhaustive integer search over 𝒰 = [−Δ,Δ]² using the
 *  overlap-normalized cost (B.3). Exhaustive, therefore GLOBALLY optimal within
 *  the jitter prior. This matters because the redescending loss of §B.3 is
 *  non-convex in δ: gradient descent from zero can and does land in a local
 *  minimum, and Lemma B.3 guarantees only descent, not global optimality.
 *  Stage A removes that risk outright rather than mitigating it.
 *
 *  Stage B — symmetric-stencil Gauss–Newton IRLS (B.5)–(B.11) for sub-pixel
 *  accuracy. The half-shifted stencil is NOT cosmetic: Lemma B.2 shows the
 *  one-sided expansion carries an O(‖δ‖²‖H‖) bias — the classical "shift toward
 *  the smoother frame" — whereas the symmetric one carries
 *  O(‖δ‖²‖H_i − H_j‖), which for two frames of the same animation is an order
 *  smaller. Identical cost, one fewer bias term.
 *
 * SIGN CONVENTION (§B.2, checked once explicitly): with f_i(x) = S(x − τ_i),
 * f_i(x) and f_j(x − u) coincide iff u = τ_i − τ_j. We warp f_i to x + δ/2 and
 * f_j to x − u₀ − δ/2, so the net relative shift is u = u₀ + δ, hence
 * d_ij = u₀ + δ̂ ≈ τ_i − τ_j  (B.15). That matches the residual
 * t_i − t_j − d_ij in (A.2) and the correction c = −Π t̂ in (A.4).
 */

import {
  FINE_INTEGER_RADIUS,
  IRLS_MAX_ITERS,
  MIN_SUPPORT_MASS,
  SUBPIXEL_TOL,
} from "./constants";
import { bitmapVector } from "./coords";
import { CompensatedSum, sym2, sym2Solve } from "./linalg";
import {
  kappaSchedule,
  lossValue,
  lossWeight,
  madScale,
  type LossKind,
} from "./robust";
import {
  boxIsEmpty,
  integerCost,
  pairRoi,
  samplePlane,
  sampleScalar,
  type PlaneSample,
} from "./support";
import type {
  EdgeSpec,
  FrameSignal,
  IrlsIterate,
  PairwiseConstraint,
  PixelBox,
  RobustScale,
  SignalLevel,
  SymMat2,
} from "./types";
import {
  informationMatrix,
  informationSpectrum,
  isDegenerate,
  residualVariance,
} from "./weights";

export interface PairwiseParams {
  readonly searchRadius: number;
  readonly loss: LossKind;
}

/* ============================ Stage A ============================ */

interface IntegerResult {
  ux: number;
  uy: number;
  cost: number;
  mass: number;
}

/**
 * Exhaustive argmin of C_ij (B.3) over an integer window.
 *
 * TIE-BREAKING: ascending (uy, ux) traversal with STRICT improvement, so two
 * bit-identical costs resolve to the lexicographically smaller u. Deterministic
 * by construction — §1.3 invariant 4.
 */
function searchIntegers(
  a: SignalLevel,
  b: SignalLevel,
  centerX: number,
  centerY: number,
  radius: number,
  limit: number,
  roi: PixelBox
): IntegerResult {
  let best: IntegerResult = {
    ux: centerX,
    uy: centerY,
    cost: Number.POSITIVE_INFINITY,
    mass: 0,
  };

  for (let dy = -radius; dy <= radius; dy++) {
    const uy = centerY + dy;
    if (Math.abs(uy) > limit) continue;

    for (let dx = -radius; dx <= radius; dx++) {
      const ux = centerX + dx;
      if (Math.abs(ux) > limit) continue;

      const { cost, mass } = integerCost(a, b, ux, uy, roi);
      if (cost < best.cost) best = { ux, uy, cost, mass };
    }
  }
  return best;
}

/* ==================== Stage B: accumulation ==================== */

interface Accumulation {
  M: SymMat2;
  qx: number;
  qy: number;
  mass: number;
  effectiveSamples: number;
  weightedSquaredResidual: number;
  objective: number;
  rejectedEnergy: number;
  totalEnergy: number;
  sampleCount: number;
}

/**
 * One linearization pass: fill the residual field, derive the MAD scale from
 * it, then accumulate M (B.9) and q (B.10) with the resulting weights.
 *
 * TWO SWEEPS ARE STRUCTURALLY NECESSARY, not an oversight: κ depends on the
 * MEDIAN of the residual field (B.18) and the weights depend on κ. The MAD is
 * not replaceable by a running estimate without losing its 50% breakdown, and
 * that breakdown is precisely the property §C.1 relies on to excise a blink
 * rather than be inflated by it.
 */
function accumulate(
  a: SignalLevel,
  b: SignalLevel,
  u0x: number,
  u0y: number,
  dx: number,
  dy: number,
  roi: PixelBox,
  loss: LossKind,
  kappaMultiplier: number,
  residualBuffer: Float64Array
): { acc: Accumulation; scale: RobustScale } {
  const halfX = dx * 0.5;
  const halfY = dy * 0.5;

  const sa: PlaneSample = { v: 0, gx: 0, gy: 0 };
  const sl: PlaneSample = { v: 0, gx: 0, gy: 0 };
  const sb: PlaneSample = { v: 0, gx: 0, gy: 0 };
  const sm: PlaneSample = { v: 0, gx: 0, gy: 0 };

  /* ---- sweep 1: residual field, for the MAD scale (B.18) ---- */
  let count = 0;
  for (let y = roi.minY; y < roi.maxY; y++) {
    for (let x = roi.minX; x < roi.maxX; x++) {
      const axp = x + halfX;
      const ayp = y + halfY;
      const bxp = x - u0x - halfX;
      const byp = y - u0y - halfY;

      const supA = sampleScalar(a.support, a.width, a.height, axp, ayp);
      if (supA <= 0) continue;
      const supB = sampleScalar(b.support, b.width, b.height, bxp, byp);
      if (supB <= 0) continue;

      samplePlane(a.alpha, a.width, a.height, axp, ayp, sa);
      samplePlane(a.luma, a.width, a.height, axp, ayp, sl);
      samplePlane(b.alpha, b.width, b.height, bxp, byp, sb);
      samplePlane(b.luma, b.width, b.height, bxp, byp, sm);

      const da = sa.v - sb.v;
      const dl = sl.v - sm.v;
      residualBuffer[count++] = Math.sqrt(da * da + dl * dl);
    }
  }

  const scale = madScale(residualBuffer, count, loss, kappaMultiplier);
  const kappa = scale.kappa;

  /* ---- sweep 2: M (B.9), q (B.10), σ̂² numerator (B.14), η (C.1) ---- */
  const mxx = new CompensatedSum();
  const mxy = new CompensatedSum();
  const myy = new CompensatedSum();
  const qxs = new CompensatedSum();
  const qys = new CompensatedSum();
  const massSum = new CompensatedSum();
  const effSum = new CompensatedSum();
  const wsr = new CompensatedSum();
  const obj = new CompensatedSum();
  const rejectedEnergy = new CompensatedSum();
  const totalEnergy = new CompensatedSum();
  let samples = 0;

  for (let y = roi.minY; y < roi.maxY; y++) {
    for (let x = roi.minX; x < roi.maxX; x++) {
      const axp = x + halfX;
      const ayp = y + halfY;
      const bxp = x - u0x - halfX;
      const byp = y - u0y - halfY;

      const supA = sampleScalar(a.support, a.width, a.height, axp, ayp);
      if (supA <= 0) continue;
      const supB = sampleScalar(b.support, b.width, b.height, bxp, byp);
      if (supB <= 0) continue;

      // m_ij(x,u) = α_i·α_j — a PRODUCT (A.1), so a boundary pixel that is
      // half-transparent in one frame and opaque in the other gets weight 0.5.
      // Antialiased silhouette edges therefore cannot dominate the residual the
      // way an alpha-mismatch term would (§C.4).
      const m = supA * supB;

      samplePlane(a.alpha, a.width, a.height, axp, ayp, sa);
      samplePlane(a.luma, a.width, a.height, axp, ayp, sl);
      samplePlane(b.alpha, b.width, b.height, bxp, byp, sb);
      samplePlane(b.luma, b.width, b.height, bxp, byp, sm);

      const da = sa.v - sb.v;
      const dl = sl.v - sm.v;
      const r = Math.sqrt(da * da + dl * dl);

      // ∇̄_c = ½(∇f_i + ∇g_j) — the SYMMETRIC stencil of (B.6). Lemma B.2: this
      // is the term that removes the one-sided O(‖δ‖²‖H‖) bias.
      const gax = 0.5 * (sa.gx + sb.gx);
      const gay = 0.5 * (sa.gy + sb.gy);
      const glx = 0.5 * (sl.gx + sm.gx);
      const gly = 0.5 * (sl.gy + sm.gy);

      const energy = gax * gax + gay * gay + glx * glx + gly * gly;
      totalEnergy.add(m * energy);

      const w = lossWeight(loss, r, kappa);
      if (w <= 0) {
        // EXACTLY zero influence (Theorem C.1): a blink, an occlusion or a
        // moved limb is excised, not down-weighted. The loss still contributes
        // its constant tail, so the objective remains comparable across
        // iterations for the monotonicity check of Lemma B.3.
        rejectedEnergy.add(m * energy);
        obj.add(m * lossValue(loss, r, kappa));
        continue;
      }

      const mw = m * w;

      // M = Σ m w Σ_c ∇̄_c ∇̄_cᵀ   (B.9)
      mxx.add(mw * (gax * gax + glx * glx));
      mxy.add(mw * (gax * gay + glx * gly));
      myy.add(mw * (gay * gay + gly * gly));

      // q = Σ m w Σ_c Δ_c ∇̄_c    (B.10)
      qxs.add(mw * (da * gax + dl * glx));
      qys.add(mw * (da * gay + dl * gly));

      massSum.add(m);
      effSum.add(mw);
      wsr.add(mw * (da * da + dl * dl)); // numerator of σ̂² (B.14)
      obj.add(m * lossValue(loss, r, kappa));
      samples++;
    }
  }

  const acc: Accumulation = {
    M: sym2(mxx.value, mxy.value, myy.value),
    qx: qxs.value,
    qy: qys.value,
    mass: massSum.value,
    effectiveSamples: effSum.value,
    weightedSquaredResidual: wsr.value,
    objective: obj.value,
    rejectedEnergy: rejectedEnergy.value,
    totalEnergy: totalEnergy.value,
    sampleCount: samples,
  };

  return { acc, scale: { ...scale, effectiveSampleCount: effSum.value } };
}

/* ======================= Public estimator ======================= */

function failure(
  edge: EdgeSpec,
  reason: NonNullable<PairwiseConstraint["failure"]>
): PairwiseConstraint {
  const zero = sym2(0, 0, 0);
  return {
    edge,
    displacement: bitmapVector(0, 0),
    integerSeed: bitmapVector(0, 0),
    structureTensor: zero,
    residualVariance: Number.POSITIVE_INFINITY,
    information: zero,
    informationSpectrum: informationSpectrum(zero),
    supportMass: 0,
    scale: { sHat: 0, kappa: 0, inlierFraction: 0, effectiveSampleCount: 0 },
    iterates: [],
    clampedToPrior: false,
    rejectedEnergyFraction: 0,
    failure: reason,
  };
}

/**
 * Estimate d_ij for one edge — the whole of §B.2 for a single pair.
 *
 * COARSE-TO-FINE INTEGER SEEDING: exhaustive over 𝒰/2 at level 1, upscaled ×2,
 * then an exhaustive ±1 window at level 0. BOTH stages are exhaustive, so the
 * composite remains free of local-minimum risk within the prior, at roughly a
 * quarter of the cost of searching (2Δ+1)² at full resolution (§D).
 *
 * A failed measurement is returned as a PairwiseConstraint with `failure` set
 * and zero information, never thrown: §A.5 requires that an unmeasurable pair
 * degrade the graph (dropping to an isolated component whose minimum-norm
 * solution is t_i = 0) rather than abort the run.
 */
export function estimatePair(
  edge: EdgeSpec,
  from: FrameSignal,
  to: FrameSignal,
  params: PairwiseParams
): PairwiseConstraint {
  if (!from.usable || !to.usable) return failure(edge, "blank-frame");

  const coarseA = from.levels[1] ?? from.levels[0];
  const coarseB = to.levels[1] ?? to.levels[0];
  const fineA = from.levels[0];
  const fineB = to.levels[0];

  const limit = params.searchRadius;

  /* ---- Stage A.1: exhaustive integer search at half resolution (§D) ---- */
  const coarseLimit = Math.ceil(limit / 2);
  const coarseRoi = pairRoi(coarseA, coarseB, coarseLimit);
  if (boxIsEmpty(coarseRoi)) return failure(edge, "insufficient-support");

  const coarse = searchIntegers(
    coarseA,
    coarseB,
    0,
    0,
    coarseLimit,
    coarseLimit,
    coarseRoi
  );

  /* ---- Stage A.2: exhaustive ±1 refinement at full resolution ---- */
  const fineRoi = pairRoi(fineA, fineB, limit);
  if (boxIsEmpty(fineRoi)) return failure(edge, "insufficient-support");

  const seed = searchIntegers(
    fineA,
    fineB,
    2 * coarse.ux,
    2 * coarse.uy,
    FINE_INTEGER_RADIUS,
    limit,
    fineRoi
  );

  if (!(seed.mass >= MIN_SUPPORT_MASS)) {
    return failure(edge, "insufficient-support");
  }

  /* ---- Stage B: symmetric-stencil Gauss–Newton IRLS (B.5)–(B.11) ---- */
  const roiArea = (fineRoi.maxX - fineRoi.minX) * (fineRoi.maxY - fineRoi.minY);
  const residualBuffer = new Float64Array(Math.max(1, roiArea));

  let dx = 0;
  let dy = 0;
  const iterates: IrlsIterate[] = [];
  let iteration = 0;

  // Graduated non-convexity (§B.3): κ ∈ {4ŝ, 2ŝ, κ_final}. The first stage is
  // effectively quadratic, hence convex, and its unique solution seeds the
  // next. Fixed schedule × fixed iteration cap ⇒ deterministic (§1.3 inv. 2).
  for (const kappaMultiplier of kappaSchedule()) {
    for (let k = 0; k < IRLS_MAX_ITERS; k++) {
      const pass = accumulate(
        fineA,
        fineB,
        seed.ux,
        seed.uy,
        dx,
        dy,
        fineRoi,
        params.loss,
        kappaMultiplier,
        residualBuffer
      );

      // δ ← δ − M⁻¹q  (B.11). A singular M is the aperture problem (B.12), not
      // an error: we stop refining rather than invent a direction, and report
      // the deficiency through the information matrix instead.
      const step = sym2Solve(pass.acc.M, -pass.acc.qx, -pass.acc.qy);
      if (!step) break;

      dx += step.x;
      dy += step.y;

      // Clamp to the prior box 𝒰 (§B.2 Step 5).
      const cx = Math.max(-limit, Math.min(limit, seed.ux + dx));
      const cy = Math.max(-limit, Math.min(limit, seed.uy + dy));
      dx = cx - seed.ux;
      dy = cy - seed.uy;

      const stepInf = Math.max(Math.abs(step.x), Math.abs(step.y));
      iterates.push({
        iteration: iteration++,
        kappa: pass.scale.kappa,
        delta: bitmapVector(dx, dy),
        stepInfNorm: stepInf,
        objective: pass.acc.objective,
      });

      if (stepInf < SUBPIXEL_TOL) break;
    }
  }

  /* ---- final accumulation at the converged δ: M, σ̂², A_ij ---- */
  const schedule = kappaSchedule();
  const final = accumulate(
    fineA,
    fineB,
    seed.ux,
    seed.uy,
    dx,
    dy,
    fineRoi,
    params.loss,
    schedule[schedule.length - 1],
    residualBuffer
  );

  if (!(final.acc.mass >= MIN_SUPPORT_MASS)) {
    return failure(edge, "insufficient-support");
  }

  const sigmaSq = residualVariance(
    final.acc.weightedSquaredResidual,
    final.acc.effectiveSamples
  );
  const information = informationMatrix(final.acc.M, sigmaSq);
  const spectrum = informationSpectrum(information);

  if (isDegenerate(spectrum)) return failure(edge, "degenerate-information");

  const ux = seed.ux + dx;
  const uy = seed.uy + dy;

  // Saturating the prior box means the measurement contradicts the 1–3 px
  // jitter model of §0; curl.ts decides what to do about it.
  const clampedToPrior =
    Math.abs(ux) >= limit - 1e-9 || Math.abs(uy) >= limit - 1e-9;

  return {
    edge,
    displacement: bitmapVector(ux, uy), // d_ij = u₀ + δ̂  (B.15)
    integerSeed: bitmapVector(seed.ux, seed.uy),
    structureTensor: final.acc.M,
    residualVariance: sigmaSq,
    information, // A_ij = M/σ̂²  (B.14) — its own inverse covariance
    informationSpectrum: spectrum,
    supportMass: final.acc.mass,
    scale: final.scale,
    iterates,
    clampedToPrior,
    // η of (C.1): the share of gradient energy the robust loss excised. This is
    // the quantity that bounds the bias in Proposition C.2, so it is reported
    // rather than discarded.
    rejectedEnergyFraction:
      final.acc.totalEnergy > 0
        ? final.acc.rejectedEnergy / final.acc.totalEnergy
        : 0,
    failure: null,
  };
}
