// ───────────────────────────── lib/lsa/types.ts ─────────────────────────────

/* ========== 0. Scalars, aliases, branded units ========== */

/** Frame index i ∈ ℤ_N. Arithmetic on it is modular (Constraint 5). */
export type FrameIndex = number;

/** Temporal lag ℓ ∈ Λ_N = { 2^k : 2^k ≤ ⌊N/2⌋ }  — (B.19). */
export type Lag = number;

/** FNV-1a digest of decoded pixels. Memoization key and determinism witness. */
export type FrameContentHash = string;

/** Units of a displacement. The paper works in BITMAP px; Frame.x/y are FRAME px. */
export type DisplacementSpace = "bitmap" | "frame";

/* ========== 1. Geometry ========== */

/**
 * A displacement in ℝ². Used for τ_i, t_i, d_ij, δ̂ and c_i alike; the `space`
 * tag prevents the one class of bug `coords.ts` exists to eliminate.
 */
export interface TranslationVector {
  /** Horizontal component, sub-pixel. */
  readonly dx: number;
  /** Vertical component, sub-pixel. */
  readonly dy: number;
  /** Which coordinate system dx/dy are expressed in. */
  readonly space: DisplacementSpace;
}

export interface PixelBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}
/**
 * Symmetric 2×2 matrix in packed upper-triangular form.
 * Carries the structure tensor M (B.9), the information matrix A_ij (B.14),
 * and the curl covariance Σ_γ (Lemma B.7).
 */
export interface SymMat2 {
  readonly xx: number;
  readonly xy: number;
  readonly yy: number;
}

/** Eigen-decomposition of a SymMat2 — the anisotropy / aperture report (B.12). */
export interface Mat2Spectrum {
  /** λ_min(M): zero ⇔ aperture problem along the corresponding eigenvector. */
  readonly lambdaMin: number;
  /** λ_max(M). */
  readonly lambdaMax: number;
  /** Unit eigenvector of λ_min — the direction this edge does NOT constrain. */
  readonly weakAxis: { readonly x: number; readonly y: number };
  /** λ_min / λ_max ∈ [0,1]. 1 = isotropic; ~0 = rank-1 (line-only information). */
  readonly conditionRatio: number;
}

/* ========== 2. Pixel-stage inputs ========== */

/** A frame's pixels at native cell resolution — the lattice Ω (§0). */
export interface DecodedFrame {
  readonly index: FrameIndex;
  /** |Ω| = W·H addressable samples; W,H identical across all frames (§0). */
  readonly width: number;
  readonly height: number;
  /** RGBA8, NON-premultiplied, exactly as decoded. Never mutated. */
  readonly rgba: Uint8ClampedArray;
  readonly hash: FrameContentHash;
  /** Σ_x α_i(x) / |Ω| — occupancy. 0 ⇒ blank frame ⇒ isolated graph node. */
  readonly alphaMass: number;
}

/** One scalar plane of f_i, prefiltered per (B.2), with its central differences. */
export interface SignalPlane {
  /** K_σ * (premultiplied channel), zero-padded (B.2). */
  readonly value: Float32Array;
  /** ∂/∂x of `value`. Used in ∇̄ (B.6). */
  readonly gx: Float32Array;
  /** ∂/∂y of `value`. */
  readonly gy: Float32Array;
  /** Pooled RMS gradient magnitude s_c used to normalize this channel (§B.1). */
  readonly normScale: number;
}

/**
 * f_i = (F_i^(a)/s_a, F_i^(y)/s_y) — the translation-equivariant signal of §B.1,
 * at one resolution level.
 */
export interface SignalLevel {
  readonly width: number;
  readonly height: number;

  readonly alpha: SignalPlane;
  readonly luma: SignalPlane;
  readonly support: Float32Array;

  readonly gradientEnergy: number;
  readonly supportBox: PixelBox;
}

/** Two-level pyramid: level 1 for the integer search (§D), level 0 for refinement. */
export interface FrameSignal {
  readonly index: FrameIndex;
  readonly hash: FrameContentHash;
  /** levels[0] = native Ω; levels[1] = half resolution. */
  readonly levels: readonly SignalLevel[];
  /** True ⇔ alphaMass > 0; false frames are excluded from E entirely. */
  readonly usable: boolean;
}

/* ========== 3. Robust-estimation state (§B.3) ========== */

/** MAD-derived scale and cut-off — (B.18). */
export interface RobustScale {
  /** ŝ = 1.4826 · med|r − med r|. 50%-breakdown scale estimate. */
  readonly sHat: number;
  /** κ = 4.685 · ŝ (95% Gaussian efficiency). Residuals beyond κ have w = 0. */
  readonly kappa: number;
  /** Fraction of supported pixels with w(x) > 0 — the inlier share. */
  readonly inlierFraction: number;
  /** Σ_x m·w — effective sample count; feeds the d.o.f. term of (B.14). */
  readonly effectiveSampleCount: number;
}

/** One IRLS iterate; retained for convergence auditing (Lemma B.3 monotonicity). */
export interface IrlsIterate {
  readonly iteration: number;
  /** κ at this step of the graduated schedule (§B.3). */
  readonly kappa: number;
  /** δ after the Gauss–Newton update δ ← δ − M⁻¹q  (B.11). */
  readonly delta: TranslationVector;
  /** ‖M⁻¹q‖_∞ — the step size; termination when < 1e-3 px. */
  readonly stepInfNorm: number;
  /** Robust objective 𝓔(δ). MUST be non-increasing (Lemma B.3). */
  readonly objective: number;
}

/* ========== 4. Pairwise stage output (§B.2) ========== */

/** An ordered measurement slot (i → j) in the graph, before it is measured. */
export interface EdgeSpec {
  /** Canonical position in E; fixes accumulation order (determinism). */
  readonly id: number;
  readonly from: FrameIndex;
  readonly to: FrameIndex;
  /** Temporal lag ℓ, i.e. (to − from) mod N — (B.19). */
  readonly lag: Lag;
  /** True for ℓ = 1. Protected: may be down-weighted, never removed (§B.4.3). */
  readonly isRingEdge: boolean;
  /** True for the wrap edge (N−1 → 0). The loop seam (Constraint 5). */
  readonly isSeamEdge: boolean;
}

/**
 * d_ij ≈ τ_i − τ_j together with everything needed to weight it optimally.
 * The sole carrier of information between Stage 1 and Stage 2.
 */
export interface PairwiseConstraint {
  readonly edge: EdgeSpec;
  /** d_ij = u₀ + δ̂ — (B.15). Bitmap space. */
  readonly displacement: TranslationVector;
  /** u₀: the globally optimal integer minimizer of C_ij over 𝒰 (B.3). */
  readonly integerSeed: TranslationVector;
  /** Weighted multi-channel structure tensor M (B.9) at the solution. */
  readonly structureTensor: SymMat2;
  /** σ̂²_ij with the (C·Σmw − 2) d.o.f. correction — (B.14). */
  readonly residualVariance: number;
  /** A_ij = M / σ̂² — the inverse covariance of THIS measurement (B.14). */
  readonly information: SymMat2;
  /** Eigenstructure of A_ij; exposes the aperture problem (B.12). */
  readonly informationSpectrum: Mat2Spectrum;
  /** Σ_x m_ij at the solution: mutual opacity mass. Low ⇒ little overlap (§C.4). */
  readonly supportMass: number;
  readonly scale: RobustScale;
  /** IRLS trace. Length ≤ IRLS_MAX_ITERS. Empty ⇒ integer-only fallback. */
  readonly iterates: readonly IrlsIterate[];
  /** True if ‖u₀+δ‖_∞ hit the prior boundary Δ — the measurement is suspect. */
  readonly clampedToPrior: boolean;
  readonly rejectedEnergyFraction: number;
  readonly failure: EdgeRejectionReason | null;
}

/* ========== 5. Graph stage (§B.4) ========== */

/** The measurement graph G = (ℤ_N, E) plus the algebra derived from it. */
export interface ConstraintGraph {
  /** N ∈ [2, 64] (Constraint 4). */
  readonly frameCount: number;
  /** Frames with usable pixels; blank frames are absent. */
  readonly nodes: readonly FrameIndex[];
  /** E in canonical order — (B.19). Indexed by EdgeSpec.id. */
  readonly edges: readonly EdgeSpec[];
  /** Adjacency by node, edge ids only (no object graph ⇒ cloneable). */
  readonly incidence: ReadonlyMap<FrameIndex, readonly number[]>;
  /** Connected components over `nodes`. dim ker 𝓛 = 2·components.length (§A.5). */
  readonly components: readonly (readonly FrameIndex[])[];
  /** Triangles γ_{i,ℓ} forming the cycle basis used by §B.4.3. */
  readonly cycleBasis: readonly CycleSpec[];
  /** |E| − |V| + |components| — the cycle rank; residual dim = 2·this (Thm B.6). */
  readonly cycleRank: number;
}

/** A cycle γ with its signed edge indicator z_γ — (A.5). */
export interface CycleSpec {
  readonly id: number;
  readonly edgeIds: readonly number[];
  /** +1 / −1 per edge, matching the traversal orientation. */
  readonly signs: readonly (1 | -1)[];
}

/** Result of the calibrated χ²₂ consistency test on one cycle — (B.20). */
export interface CurlResidual {
  readonly cycle: CycleSpec;
  /** z_γᵀd. Depends on NO unknown; zero ⇔ mutually consistent measurements. */
  readonly curl: TranslationVector;
  /** Σ_γ = Σ_{e∈γ} A_e⁻¹. */
  readonly covariance: SymMat2;
  /** χ²_γ = curlᵀ Σ_γ⁻¹ curl ~ χ²₂ under H₀. */
  readonly chiSquared: number;
}

/** An edge admitted to the solver, carrying its final (possibly scaled) weight. */
export interface WeightedEdge {
  readonly edge: EdgeSpec;
  /** d_ij as measured. */
  readonly displacement: TranslationVector;
  /** Final A_ij actually assembled into 𝓛 and b. */
  readonly information: SymMat2;
  /** Multiplier applied to A_ij: 1 = untouched, <1 = ring edge tempered (§B.4.3). */
  readonly informationScale: number;
  /** Median χ² over the triangles containing this edge. */
  readonly medianChiSquared: number;
  readonly admitted: boolean;
  readonly rejectionReason: EdgeRejectionReason | null;
}

export type EdgeRejectionReason =
  | "curl-inconsistent"      // median χ²_γ > 13.816 (99.9% of χ²₂)
  | "insufficient-support"   // Σ m_ij too small for a meaningful σ̂² (§C.4)
  | "degenerate-information" // A_ij ≈ 0: no gradient energy at all
  | "clamped-to-prior"       // measurement saturated 𝒰; violates the jitter prior
  | "blank-frame";           // endpoint has α ≡ 0

/* ========== 6. Solver stage (§B.5–B.6) ========== */

/** Everything the solver produces, before Π is applied. */
export interface SolverSolution {
  /** t̂ = 𝓛⁺b, satisfying Σ_i t̂_i = 0 (A.3, Prop. B.9). Bitmap space. */
  readonly offsets: readonly TranslationVector[];
  /** Per-frame covariance diag(𝓛⁺) — the reported uncertainty (Lemma B.5). */
  readonly covariances: readonly SymMat2[];
  readonly statistics: SolverStatistics;
}

export interface SolverStatistics {
  /** F(t̂) at the optimum — equals ‖P_{cycle} d‖²_W (Theorem B.6). */
  readonly objectiveValue: number;
  /** Per-edge residual t̂_i − t̂_j − d_ij. On a bare ring: exactly −curl/N (Cor B.8). */
  readonly edgeResiduals: readonly TranslationVector[];
  /** Σ_i d_{i,i+1} around the loop: the closure error, per axis. */
  readonly loopClosure: TranslationVector;
  /** λ_min of 𝓛 restricted to 𝟙⊥. Drives the O(λ_min^{-1/2}) term of Thm B.11. */
  readonly lambdaMinOnGaugeSlice: number;
  /** κ(𝓛 + gauge augmentation). The numerical-stability witness (§D). */
  readonly conditionNumber: number;
  /** λ actually used in the Tikhonov term (§B.4.2). */
  readonly tikhonov: number;
  /** max_{i,j} R_eff(i,j): bounds global drift. O(log N) with dyadic edges (Lem B.5). */
  readonly maxEffectiveResistance: number;
  /** Verification that 𝟙ᵀb = 0 (Theorem A.1(iii)) — should be ~1e-15. */
  readonly consistencyResidual: number;
  /** Verification of the gauge: ‖Σ_i t̂_i‖. */
  readonly gaugeResidual: number;
  readonly admittedEdgeCount: number;
  readonly rejectedEdgeCount: number;
  readonly componentCount: number;
  readonly choleskySucceeded: boolean;
}

/* ========== 7. Spectral stage (§B.7) ========== */

/** Policy for separating jitter from intended global motion (Constraint 6). */
export interface SpectralPolicy {
  /** "hard": 𝒫 by Fisher g-test (B.29). "wiener": soft shrinkage η_k. "off": 𝒫={0}. */
  readonly mode: "hard" | "wiener" | "off";
  /** Largest |k| eligible for 𝒫. Default 2 (§B.7: intended motion is low-order). */
  readonly maxHarmonic: number;
  /** Bonferroni-corrected significance for the g-test. Default 0.01. */
  readonly alpha: number;
}

export interface SpectralDecision {
  /** ‖T̂_k‖² per harmonic, k = 0..N−1 (B.28). Flat under pure jitter. */
  readonly periodogram: readonly number[];
  /** ν̂ = med_{|k|>N/4} ‖T̂_k‖² — the white jitter floor (B.29). */
  readonly whiteFloor: number;
  /** G_k = ‖T̂_k‖²/ν̂ for tested harmonics. */
  readonly gStatistics: ReadonlyMap<number, number>;
  /** 𝒫: harmonics declared intentional and left untouched. Always contains 0. */
  readonly preservedHarmonics: readonly number[];
  /** η_k ∈ [0,1] per harmonic in "wiener" mode; all 0/1 in "hard" mode. */
  readonly shrinkage: readonly number[];
  /** Energy fraction of t̂ classified as intended motion, for UI reporting. */
  readonly preservedEnergyFraction: number;
  readonly criticalValue: number;
}

/* ========== 8. Request / result ========== */

export interface StabilizeOptions {
  /** Δ in 𝒰 = [−Δ,Δ]². Default 4 (the jitter prior, §A.3.8). */
  readonly searchRadius: number;
  /** σ of K_σ (B.2). Default 1.2 px. */
  readonly prefilterSigma: number;
  readonly robustLoss: "tukey" | "geman-mcclure";
  readonly spectral: SpectralPolicy;
  /** Run §B.4.3 edge rejection. Default true. */
  readonly enableCurlRejection: boolean;
  /** Λ_N generator. "dyadic" (B.19) | "ring" (ℓ=1 only, diagnostic comparison). */
  readonly edgeTopology: "dyadic" | "ring";
  /** Snap final frame offsets to integers. Default false: sub-pixel is legitimate. */
  readonly quantizeOutput: boolean;
}

export interface StabilizeRequest {
  readonly frames: readonly DecodedFrame[];
  readonly options: StabilizeOptions;
}

/** The complete, serializable record of one stabilization run. */
export interface LSAResult {
  /** c_i = −(Π t̂)_i  (A.4), in BITMAP space. The deliverable. */
  readonly translations: readonly TranslationVector[];
  /** t̂ before Π, retained so the spectral policy can be changed without re-solving. */
  readonly rawOffsets: readonly TranslationVector[];
  readonly constraints: readonly PairwiseConstraint[];
  readonly graph: ConstraintGraph;
  readonly edges: readonly WeightedEdge[];
  readonly curls: readonly CurlResidual[];
  readonly solution: SolverSolution;
  readonly spectral: SpectralDecision;
  /** Per-frame quality, for UI and for manual-override guidance. */
  readonly quality: readonly FrameQuality[];
  /** Input hashes + constants fingerprint: the determinism witness (§1.3). */
  readonly provenance: RunProvenance;
  readonly timings: StageTimings;
}

export interface FrameQuality {
  readonly index: FrameIndex;
  /** Degree in the admitted subgraph. 0 ⇒ correction is exactly (0,0). */
  readonly degree: number;
  /** √λ_max of the frame's covariance block: the ± px uncertainty (Lemma B.5). */
  readonly uncertaintyPx: number;
  /** η (C.1): gradient-energy fraction rejected by the robust loss — local motion. */
  readonly localMotionFraction: number;
  /** True if λ_min of the frame's aggregate information is near zero (aperture). */
  readonly apertureLimited: boolean;
}

export interface RunProvenance {
  readonly algorithmVersion: "LSA-1.0";
  readonly inputHashes: readonly FrameContentHash[];
  readonly frameCount: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  /** Hash of the effective StabilizeOptions + constants.ts values. */
  readonly constantsFingerprint: string;
}

export interface StageTimings {
  readonly decodeMs: number;
  readonly signalMs: number;
  readonly pairwiseMs: number;
  readonly graphMs: number;
  readonly curlMs: number;
  readonly solveMs: number;
  readonly spectralMs: number;
  readonly totalMs: number;
}

/* ========== 9. App-facing structural types ========== */

/**
 * The minimal shape apply.ts needs. Loop's `Frame` satisfies it structurally,
 * so lib/lsa never imports components/Canvas (dependency inversion, §6.2).
 */
export interface TranslatableFrame {
  readonly id: string;
  readonly image: string | null;
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

export interface ApplyOptions {
  readonly baseline: "current" | "zero";
  readonly quantize: boolean;
  readonly baseScale?: number;
}

export interface ProgressEvent {
  readonly stage:
    | "decode"
    | "signal"
    | "graph"
    | "pairwise"
    | "curl"
    | "solve"
    | "spectral";
  readonly completed: number;
  readonly total: number;
}