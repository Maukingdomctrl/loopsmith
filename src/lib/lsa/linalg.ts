/**
 * LSA v1.0 — small dense numerics.
 *
 * Every numerically delicate operation in the paper is one of three sizes:
 *   2×2 SPD   — structure tensor M (B.9), information A_ij (B.14), Σ_γ (Lem B.7)
 *   2N×2N SPD — the gauge-augmented Laplacian (B.26), N ≤ 64
 *   reductions — fixed-order / compensated summation
 *
 * Concentrating them here puts the floating-point reduction order — which *is*
 * the determinism guarantee of §1.3 — in one reviewable file. No external
 * linear-algebra dependency: third-party libraries do not promise a stable
 * reduction order across versions, and we need bit-identical reruns.
 *
 * Also hosts the two exact chi-square quantile inverses used by the calibrated
 * tests of (B.20) and (B.29).
 */

import type { Mat2Spectrum, SymMat2 } from "./types";
import { JACOBI_MAX_SWEEPS, JACOBI_TOL } from "./constants";

/* ============================ 2×2 symmetric ============================ */

export const SYM2_ZERO: SymMat2 = { xx: 0, xy: 0, yy: 0 };

export function sym2(xx: number, xy: number, yy: number): SymMat2 {
  return { xx, xy, yy };
}

export function sym2Add(a: SymMat2, b: SymMat2): SymMat2 {
  return { xx: a.xx + b.xx, xy: a.xy + b.xy, yy: a.yy + b.yy };
}

export function sym2Scale(a: SymMat2, s: number): SymMat2 {
  return { xx: a.xx * s, xy: a.xy * s, yy: a.yy * s };
}

export function sym2Trace(a: SymMat2): number {
  return a.xx + a.yy;
}

export function sym2Det(a: SymMat2): number {
  return a.xx * a.yy - a.xy * a.xy;
}

/** Exact 2×2 symmetric inverse. Returns null on a singular matrix — callers
 *  must treat that as the aperture problem (B.12), never as an error. */
export function sym2Inverse(a: SymMat2): SymMat2 | null {
  const det = sym2Det(a);
  if (!(Math.abs(det) > 0) || !Number.isFinite(det)) return null;
  const inv = 1 / det;
  return { xx: a.yy * inv, xy: -a.xy * inv, yy: a.xx * inv };
}

/** Solve A·x = v for symmetric 2×2 A. Closed form, no pivoting needed. */
export function sym2Solve(
  a: SymMat2,
  vx: number,
  vy: number
): { x: number; y: number } | null {
  const det = sym2Det(a);
  if (!(Math.abs(det) > 0) || !Number.isFinite(det)) return null;
  const inv = 1 / det;
  return {
    x: (a.yy * vx - a.xy * vy) * inv,
    y: (a.xx * vy - a.xy * vx) * inv,
  };
}

/** vᵀ A v for symmetric 2×2 A. */
export function sym2Quadratic(a: SymMat2, vx: number, vy: number): number {
  return a.xx * vx * vx + 2 * a.xy * vx * vy + a.yy * vy * vy;
}

/**
 * Closed-form eigen-decomposition of a symmetric 2×2 matrix.
 * λ = (T ± √(T² − 4D))/2. The `weakAxis` is the eigenvector of λ_min, i.e. the
 * direction along which the measurement carries no information (B.12).
 */
export function sym2Spectrum(a: SymMat2): Mat2Spectrum {
  const t = a.xx + a.yy;
  const d = sym2Det(a);
  const disc = Math.max(0, t * t - 4 * d);
  const root = Math.sqrt(disc);
  const lMax = 0.5 * (t + root);
  const lMin = 0.5 * (t - root);

  let vx: number;
  let vy: number;
  if (Math.abs(a.xy) > 0) {
    vx = a.xy;
    vy = lMin - a.xx;
  } else if (a.xx <= a.yy) {
    vx = 1;
    vy = 0;
  } else {
    vx = 0;
    vy = 1;
  }
  const norm = Math.sqrt(vx * vx + vy * vy) || 1;

  return {
    lambdaMin: lMin,
    lambdaMax: lMax,
    weakAxis: { x: vx / norm, y: vy / norm },
    conditionRatio: lMax > 0 ? lMin / lMax : 0,
  };
}

/** Clamp a symmetric 2×2 to the PSD cone by flooring its eigenvalues at 0. */
export function sym2ClampPsd(a: SymMat2): SymMat2 {
  const s = sym2Spectrum(a);
  if (s.lambdaMin >= 0) return a;
  const { x, y } = s.weakAxis; // unit eigenvector of the negative eigenvalue
  const c = -s.lambdaMin;
  return {
    xx: a.xx + c * x * x,
    xy: a.xy + c * x * y,
    yy: a.yy + c * y * y,
  };
}

/* ============================ Reductions ============================ */

/**
 * Neumaier (improved Kahan) compensated accumulator.
 * Used wherever a reduction runs over |Ω| ≈ 10⁴–10⁵ terms of widely varying
 * magnitude — the structure tensor and the robust objective. Fixed traversal
 * order plus compensation makes the result reproducible AND accurate.
 */
export class CompensatedSum {
  private s = 0;
  private c = 0;

  add(x: number): void {
    const t = this.s + x;
    if (Math.abs(this.s) >= Math.abs(x)) {
      this.c += this.s - t + x;
    } else {
      this.c += x - t + this.s;
    }
    this.s = t;
  }

  get value(): number {
    return this.s + this.c;
  }

  reset(): void {
    this.s = 0;
    this.c = 0;
  }
}

/**
 * Deterministic median of a Float64Array slice.
 * Sorts a copy: TypedArray.prototype.sort is numeric and total on finite
 * values, so the result is independent of engine and of input permutation.
 * A selection algorithm would be faster but introduces pivot-order sensitivity
 * on ties, which §1.3 invariant 4 forbids.
 */
export function median(values: Float64Array, count: number): number {
  if (count <= 0) return 0;
  const copy = values.slice(0, count);
  copy.sort();
  const mid = count >> 1;
  return count % 2 === 1 ? copy[mid] : 0.5 * (copy[mid - 1] + copy[mid]);
}

/* ====================== Dense symmetric linear algebra ====================== */

/**
 * In-place Cholesky factorization A = L·Lᵀ of a dense symmetric matrix stored
 * row-major in `a` (n×n). Only the lower triangle of `a` is written.
 * Returns false if A is not positive definite — for the augmented system of
 * (B.26) that can only mean an assembly bug, so callers should surface it.
 *
 * Fixed (j, k, i) traversal order; no pivoting. Pivoting would make the
 * reduction order data-dependent and is unnecessary for an SPD matrix.
 */
export function choleskyFactor(a: Float64Array, n: number): boolean {
  for (let j = 0; j < n; j++) {
    let diag = a[j * n + j];
    for (let k = 0; k < j; k++) {
      const v = a[j * n + k];
      diag -= v * v;
    }
    if (!(diag > 0) || !Number.isFinite(diag)) return false;
    const l = Math.sqrt(diag);
    a[j * n + j] = l;

    for (let i = j + 1; i < n; i++) {
      let sum = a[i * n + j];
      for (let k = 0; k < j; k++) {
        sum -= a[i * n + k] * a[j * n + k];
      }
      a[i * n + j] = sum / l;
    }
  }
  return true;
}

/** Solve L·Lᵀ·x = b in place on a copy of b. `l` is the output of choleskyFactor. */
export function choleskySolve(
  l: Float64Array,
  n: number,
  b: Float64Array
): Float64Array {
  const x = b.slice();

  // Forward substitution: L·y = b
  for (let i = 0; i < n; i++) {
    let sum = x[i];
    for (let k = 0; k < i; k++) sum -= l[i * n + k] * x[k];
    x[i] = sum / l[i * n + i];
  }
  // Back substitution: Lᵀ·x = y
  for (let i = n - 1; i >= 0; i--) {
    let sum = x[i];
    for (let k = i + 1; k < n; k++) sum -= l[k * n + i] * x[k];
    x[i] = sum / l[i * n + i];
  }
  return x;
}

/**
 * Full inverse of an SPD matrix from its Cholesky factor, by n triangular
 * solves against the unit basis. n ≤ 128 here, so the O(n³) cost is ~1 Mflop —
 * far cheaper than the pairwise stage, and it gives the diagonal blocks of 𝓛⁺
 * needed for the per-frame uncertainties of Lemma B.5.
 */
export function choleskyInverse(l: Float64Array, n: number): Float64Array {
  const inv = new Float64Array(n * n);
  const e = new Float64Array(n);

  for (let c = 0; c < n; c++) {
    e.fill(0);
    e[c] = 1;
    const col = choleskySolve(l, n, e);
    for (let r = 0; r < n; r++) inv[r * n + c] = col[r];
  }
  return inv;
}

/**
 * Eigenvalues of a dense symmetric matrix by cyclic Jacobi rotations, returned
 * ascending. Deterministic: fixed sweep order, fixed sweep cap, no pivot search.
 *
 * Used only for diagnostics — λ_min on the gauge slice (Theorem B.11's error
 * term) and the condition number (§D). Never on the solution path.
 */
export function jacobiEigenvalues(
  input: Float64Array,
  n: number
): Float64Array {
  const a = input.slice();

  for (let sweep = 0; sweep < JACOBI_MAX_SWEEPS; sweep++) {
    let off = 0;
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q];
    }
    if (off <= JACOBI_TOL) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (apq === 0) continue;

        const app = a[p * n + p];
        const aqq = a[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        const t =
          Math.sign(theta || 1) /
          (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;

        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p];
          const akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k];
          const aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
      }
    }
  }

  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = a[i * n + i];
  out.sort();
  return out;
}

/* ====================== Exact chi-square quantiles ====================== */

/**
 * Upper quantile of χ²₂. The df=2 CDF is F(x) = 1 − e^{−x/2}, so the inverse is
 * exact: x = −2·ln(1 − p). At p = 0.999 this gives 13.8155…, the threshold of
 * §B.4.3 — computed rather than tabled so the calibration cannot silently rot.
 */
export function chi2Quantile2(p: number): number {
  return -2 * Math.log(1 - p);
}

/**
 * Upper quantile of χ²₄. The df=4 CDF is F(x) = 1 − e^{−x/2}(1 + x/2), which
 * has no closed-form inverse but is smooth and monotone; Newton from the
 * Wilson–Hilferty start converges to machine precision in a handful of fixed
 * steps. Deterministic: fixed start, fixed iteration count.
 *
 * Used by the calibrated harmonic test of (B.29), where the per-axis complex
 * periodogram ordinate has 4 degrees of freedom under H₀.
 */
export function chi2Quantile4(p: number): number {
  // Wilson–Hilferty initial guess.
  const k = 4;
  const z = normalQuantile(p);
  let x = k * Math.pow(1 - 2 / (9 * k) + z * Math.sqrt(2 / (9 * k)), 3);
  if (!(x > 0)) x = k;

  for (let i = 0; i < 40; i++) {
    const e = Math.exp(-x / 2);
    const f = 1 - e * (1 + x / 2) - p;      // F(x) − p
    const df = (x / 4) * e;                 // density of χ²₄
    if (!(df > 0)) break;
    const step = f / df;
    x -= step;
    if (x <= 0) x = 1e-9;
    if (Math.abs(step) < 1e-13) break;
  }
  return x;
}

/** Acklam rational approximation to Φ⁻¹; |ε| < 1.2e-9. Deterministic, no tables.
 *  Only used to seed the Newton iteration of chi2Quantile4. */
function normalQuantile(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
             1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
             6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0,
             -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1,
             2.445134137142996e0, 3.754408661907416e0];

  const pl = 0.02425;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;

  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
         (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
