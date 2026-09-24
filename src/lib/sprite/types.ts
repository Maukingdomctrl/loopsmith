
// === types.ts ===

/**
 * Loop Sprite Engine — shared immutable types and policy configuration.
 *
 * Imports nothing, so every other module can depend on this without creating a
 * cycle, and so the whole type surface can be reviewed in one sitting.
 *
 * COORDINATE CONVENTION: every coordinate, cut, offset and extent in this file
 * is an integer in ORIGINAL IMAGE SPACE. Remainder cropping is expressed as a
 * non-zero grid origin, never as a resampled intermediate bitmap, so the slicer
 * reads source pixels directly and interpolation can never occur.
 */

/** Fixed-point occupancy: integer 0..255 representing the real interval [0,1]. */
export type Q8 = number;

export const Q8_ZERO = 0 as const;
export const Q8_ONE = 255 as const;

/** How the occupancy field was derived from the source pixels. */
export type OccupancyKind =
  | "alpha" // Case A: a meaningful alpha channel exists
  | "background" // Case B: opaque, with a uniform background colour
  | "gradient" // Case C fallback (opt-in): textured background, edge energy
  | "saturated"; // Case C: no separable background — every pixel is content

/**
 * Normalised occupancy field. `data[y * width + x]` is the confidence in Q8
 * that the pixel belongs to sprite content rather than to background.
 *
 * Every downstream stage reads ONLY this, never raw RGBA. That indirection is
 * what lets one theorem serve PNG, JPEG and textured sheets unchanged.
 */
export interface OccupancyField {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly kind: OccupancyKind;
  /** Background colour in Case B, packed 0xRRGGBB. Null otherwise. */
  readonly background: number | null;
  /** Measured noise floor (L1 RGB units) subtracted before normalisation. */
  readonly noiseFloor: number;
  /** Σ data, exact. Mass fractions need no second pass. */
  readonly totalMass: number;
  /** Count of samples with data > 0. */
  readonly occupiedCount: number;
}

/** Descriptive statistics of one profile range. All fields float64. */
export interface ProfileStats {
  readonly count: number;
  readonly mean: number;
  readonly variance: number;
  readonly stdDev: number;
  readonly min: number;
  readonly max: number;
}

/**
 * Marginal projections of the occupancy field.
 *
 *   columns[x] = Σ_y occupancy(x,y)      (exact integer)
 *   rows[y]    = Σ_x occupancy(x,y)
 *
 * `smoothedColumns` / `smoothedRows` are integer-binomial-filtered copies used
 * for gap detection, where single-pixel noise would otherwise fragment runs.
 */
export interface ProjectionProfiles {
  readonly width: number;
  readonly height: number;
  readonly columns: Uint32Array;
  readonly rows: Uint32Array;
  readonly smoothedColumns: Uint32Array;
  readonly smoothedRows: Uint32Array;
  readonly columnStats: ProfileStats;
  readonly rowStats: ProfileStats;
  /** Otsu threshold on the smoothed profile, in profile units (v <= t ⇒ gap). */
  readonly columnThreshold: number;
  readonly rowThreshold: number;
}

/** A maximal run of below-threshold profile positions: a candidate gutter. */
export interface GapInterval {
  /** Inclusive. */
  readonly start: number;
  /** Inclusive. */
  readonly end: number;
  /** ⌊(start+end)/2⌋ — the seam position this gap nominates. */
  readonly center: number;
  readonly width: number;
  /** Mean profile value inside the gap. Lower is a cleaner gutter. */
  readonly meanValue: number;
  /** True when the run touches position 0 or length-1 (an outer margin). */
  readonly border: boolean;
}

/** Statistical evidence that a candidate's cut lines coincide with gutters. */
export interface SeamEvidence {
  /** Number of interior seams tested (cols-1 or rows-1). */
  readonly seamCount: number;
  /** Mean profile value on the interior seams. */
  readonly seamEnergy: number;
  /** Global mean profile value over the grid extent — the H₀ baseline. */
  readonly baseline: number;
  /** κ = 1 − seamEnergy / baseline. 1 = perfect gutters, 0 = indistinguishable. */
  readonly contrast: number;
  /** Critical κ under H₀ at the configured α. */
  readonly criticalContrast: number;
  /** κ expressed in standard errors. Diagnostics only. */
  readonly zScore: number;
  /** P1: κ ≥ criticalContrast. */
  readonly significant: boolean;
  /** P2: every interior seam lies at or below the Otsu gap threshold. */
  readonly separated: boolean;
  /** Worst (highest) interior seam value — the binding constraint for P2. */
  readonly worstSeamValue: number;
  /** True when seamCount = 0, making P1/P2 vacuous (single row or column). */
  readonly vacuous: boolean;
}

/** Period estimate for one axis. */
export type PeriodMethod = "gap-spacing" | "autocorrelation" | "none";

export interface PeriodEstimate {
  readonly method: PeriodMethod;
  /** Estimated cell pitch in pixels, integer. 0 when method is "none". */
  readonly period: number;
  /** Implied division count, round(extent / period). 0 when unavailable. */
  readonly divisions: number;
  /** Median absolute deviation of observed spacings. 0 for a perfect grid. */
  readonly mad: number;
  /** Gap centres that produced the estimate, ascending. */
  readonly centers: readonly number[];
  /** True when MAD > 1, i.e. the sheet is not uniformly ruled. */
  readonly irregular: boolean;
  /** Normalised autocorrelation peak height, when that method was used. */
  readonly strength: number;
}

/** Admissibility of a non-exact division, per the remainder theorem. */
export interface RemainderPlan {
  readonly extent: number;
  readonly divisions: number;
  readonly cellSize: number;
  /** ρ = extent − divisions·cellSize. */
  readonly remainder: number;
  /** ⌊ρ/2⌋ — pixels discarded from the low edge. */
  readonly cropLow: number;
  /** ⌈ρ/2⌉ — pixels discarded from the high edge. */
  readonly cropHigh: number;
  readonly admissible: boolean;
  /** True when ρ exceeded the relative bound but stayed under the hard cap. */
  readonly lossy: boolean;
}

/**
 * A resolved grid. Cuts are ABSOLUTE original-image coordinates, so
 * `cutsX[0] === originX` and `cutsX[cols] === originX + cols·cellWidth` for a
 * uniform grid. Irregular grids carry non-uniform cuts and `uniform === false`;
 * every consumer (ownership, slicer) reads the cut vectors, never the pitch.
 */
export interface SpriteGrid {
  readonly cols: number;
  readonly rows: number;
  /** Uniform pitch. For irregular grids this is the modal cell width. */
  readonly cellWidth: number;
  readonly cellHeight: number;
  /** Left edge of cell column 0. Non-zero after symmetric remainder cropping. */
  readonly originX: number;
  readonly originY: number;
  /** Length cols+1, strictly increasing. */
  readonly cutsX: readonly number[];
  /** Length rows+1, strictly increasing. */
  readonly cutsY: readonly number[];
  readonly uniform: boolean;
}

/** An 8-connected-labelled foreground region, before decoration merging. */
export interface ConnectedComponent {
  readonly id: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  /** Σ occupancy over the component, in Q8 units. The "ink". */
  readonly mass: number;
  readonly pixelCount: number;
}

/**
 * A sprite unit: one or more components merged by the attachment relation.
 *
 * This is the engine's answer to "what is one sprite". A crown 3 px above a
 * head is a separate COMPONENT but the same UNIT; two cats in one cell are two
 * UNITS. Component count carries no information; unit count does.
 */
export interface SpriteUnit {
  readonly id: number;
  readonly componentIds: readonly number[];
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly mass: number;
  readonly pixelCount: number;
  /** Cell index (row·cols + col) holding the largest share of this unit's ink. */
  readonly ownerCell: number;
  /** Every cell index the unit's ink touches. Ascending. */
  readonly claimCells: readonly number[];
  /** λ = 1 − maxCellMass / totalMass. Fraction of ink outside the owner cell. */
  readonly leakage: number;
  /** True when mass ≥ the dust threshold, i.e. this unit counts as a sprite. */
  readonly principal: boolean;
}

/** Cell- and unit-level acceptance analysis for one candidate. */
export interface OwnershipReport {
  readonly units: readonly SpriteUnit[];
  readonly componentCount: number;
  /** Per-cell flag: does the cell hold enough ink to count as non-empty. */
  readonly occupiedCells: Uint8Array;
  readonly occupiedCellCount: number;
  /** Per-cell count of owned units clearing the dust threshold. */
  readonly principalCounts: Uint8Array;
  readonly principalUnitCount: number;
  /** P3: max over principal units of λ. */
  readonly maxLeakage: number;
  readonly integrityOk: boolean;
  /** P4: no cell owns two or more principal units. */
  readonly singularityOk: boolean;
  /** P5: occupancy is dense and empty cells form a scan-order suffix. */
  readonly coverageOk: boolean;
  /** Index of the first violating unit or cell. −1 when clean. */
  readonly violationAt: number;
}

export type RejectionReason =
  | "no-content"
  | "cell-too-small"
  | "frame-budget"
  | "remainder-inadmissible"
  | "seam-insignificant"
  | "seam-crossed"
  | "coverage"
  | "split-sprite"
  | "grouped-sprite";

/**
 * A candidate grid plus every quantity the ranking needs.
 *
 * Fully immutable: no stage may annotate a candidate after construction. This
 * is the structural guarantee that acceptance cannot depend on evaluation
 * history — the defect that let a 38×57 grid win on a photograph.
 */
export interface GridCandidate {
  readonly grid: SpriteGrid;
  readonly remainderX: RemainderPlan;
  readonly remainderY: RemainderPlan;
  readonly seamX: SeamEvidence;
  readonly seamY: SeamEvidence;
  readonly ownership: OwnershipReport | null;
  readonly accepted: boolean;
  readonly rejection: RejectionReason | null;
  /** Φ = κx + κy − parsimony(cols·rows), quantised. Higher is better. */
  readonly score: number;
  /** ⌈log₂(cols·rows)⌉, by integer bit length — never Math.log2. */
  readonly descriptionBits: number;
  /** True when this candidate bypassed P1/P2 as a zero-gutter parse. */
  readonly phaseUnidentifiable: boolean;
}

export type DetectionConfidence =
  | "exact" // clean gutters, significant seams, no cropping
  | "high" // significant seams, minor symmetric crop
  | "lossy" // accepted, but remainder exceeded the relative bound
  | "period-only" // pitch recovered, PHASE UNIDENTIFIABLE (zero-gutter sheet)
  | "rejected"; // not a sprite sheet

export interface DetectionDiagnostics {
  readonly occupancy: OccupancyKind;
  readonly background: number | null;
  readonly noiseFloor: number;
  readonly totalMass: number;
  readonly periodX: PeriodEstimate;
  readonly periodY: PeriodEstimate;
  readonly shapesGenerated: number;
  readonly seamPassed: number;
  readonly ownershipEvaluated: number;
  readonly componentCount: number;
  readonly unitCount: number;
  readonly phaseUnidentifiable: boolean;
  /** Best few rejected candidates, canonically ordered. Diagnostics only. */
  readonly rejectedSample: readonly GridCandidate[];
}

export interface DetectionResult {
  readonly grid: SpriteGrid | null;
  readonly frameCount: number;
  readonly confidence: DetectionConfidence;
  readonly candidate: GridCandidate | null;
  readonly rejection: RejectionReason | null;
  readonly diagnostics: DetectionDiagnostics;
}

/**
 * Every policy constant in the engine, in one reviewable place.
 *
 * Ratios are expressed as integer permille/percent pairs so the defaults
 * themselves are exactly representable and diffable.
 */
export interface SpriteEngineConfig {
  /** Fraction (permille) of fully transparent pixels implying meaningful alpha. */
  readonly alphaTransparentPermille: number;
  /** Fraction (permille) of translucent pixels implying meaningful alpha. */
  readonly alphaTranslucentPermille: number;
  /** Border agreement (permille) required to declare a uniform background. */
  readonly borderUniformPermille: number;
  /** Percentile (permille) of foreground distance used as the contrast scale. */
  readonly contrastScalePermille: number;
  /** Opt-in edge-energy occupancy for textured backgrounds. Default off. */
  readonly gradientFallback: boolean;
  /** Any occupancy at or above this Q8 level is ink. 1 keeps antialiasing. */
  readonly minInkLevel: Q8;
  /** Ink (permille of a saturated cell) needed to call a cell non-empty. */
  readonly cellOccupancyPermille: number;
  /** Binomial smoothing passes applied to the projection profiles. */
  readonly smoothingPasses: number;
  /** Half-width of the seam sampling window, absorbing ±1 cut placement. */
  readonly seamRadius: number;
  /** Significance level for P1. Must match a tabulated z value. */
  readonly significanceAlpha: number;
  /** Minimum run length counted as a gutter. */
  readonly minGapWidth: number;
  /** A cell smaller than this cannot hold a sprite. */
  readonly minCellSize: number;
  readonly maxDivisions: number;
  readonly maxFrames: number;
  /** β: relative remainder tolerance, in permille of one cell. */
  readonly remainderPermille: number;
  /** Hard cap on ρ regardless of cell size. */
  readonly maxRemainder: number;
  /** κ required before a lossy remainder is tolerated. */
  readonly lossyContrastFloor: number;
  /** λmax numerator / denominator. 1/8 by the decoration-mass argument. */
  readonly maxLeakageNumerator: number;
  readonly maxLeakageDenominator: number;
  /** Attachment radius, in permille of min(width, height). Grid-independent. */
  readonly attachDistancePermille: number;
  /** γmax numerator / denominator: attach small to large, never large to large. */
  readonly massRatioNumerator: number;
  readonly massRatioDenominator: number;
  /** Dust threshold as a permille of the median unit mass. */
  readonly dustPermille: number;
  /** Minimum occupied-cell fraction, as permille. */
  readonly minOccupiedPermille: number;
  /** Require empty cells to form a scan-order suffix. */
  readonly requireEmptySuffix: boolean;
  readonly maxComponents: number;
  /** How many seam-passing candidates receive the O(WH) ownership pass. */
  readonly maxOwnershipEvaluations: number;
  /** Normalised ACF peak required to accept a zero-gutter parse. */
  readonly minAutocorrelationStrength: number;
  /** Score quantisation lattice, making float comparison a total order. */
  readonly scoreQuantum: number;
  /** Opt-in non-uniform cut vectors. Default off: variable frame sizes. */
  readonly allowIrregular: boolean;
  /** Guard against pathological inputs. */
  readonly maxPixels: number;
}

export const DEFAULT_SPRITE_CONFIG: SpriteEngineConfig = {
  alphaTransparentPermille: 5,
  alphaTranslucentPermille: 50,
  borderUniformPermille: 900,
  contrastScalePermille: 900,
  gradientFallback: false,
  minInkLevel: 12,
  cellOccupancyPermille: 1,
  smoothingPasses: 1,
  seamRadius: 2,
  significanceAlpha: 0.001,
  minGapWidth: 1,
  minCellSize: 8,
  maxDivisions: 64,
  maxFrames: 1024,
  remainderPermille: 20,
  maxRemainder: 16,
  lossyContrastFloor: 0.8,
  maxLeakageNumerator: 1,
  maxLeakageDenominator: 8,
  attachDistancePermille: 10,
  massRatioNumerator: 1,
  massRatioDenominator: 2,
  dustPermille: 20,
  minOccupiedPermille: 500,
  requireEmptySuffix: true,
  maxComponents: 4096,
  maxOwnershipEvaluations: 24,
  minAutocorrelationStrength: 0.5,
  scoreQuantum: 1000000,
  allowIrregular: false,
  maxPixels: 64000000,
};

/** A rectangle in original image space. All fields integers. */
export interface CellRect {
  readonly index: number;
  readonly col: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Candidate division counts for one axis, before pairing. */
export interface GridShape {
  readonly cols: number;
  readonly rows: number;
}

/** Output of component labelling: the label image plus region summaries. */
export interface ComponentLabelling {
  readonly width: number;
  readonly height: number;
  /** labels[y*width + x] = component id, or −1 for background. */
  readonly labels: Int32Array;
  readonly components: readonly ConnectedComponent[];
  /** True when the component cap forced small regions to be dropped. */
  readonly truncated: boolean;
}

/** Output of decoration merging: components partitioned into sprite units. */
export interface UnitGrouping {
  /** unitOfComponent[componentId] = unit index, or −1 for dropped dust. */
  readonly unitOfComponent: Int32Array;
  /** groups[unitIndex] = ascending component ids. */
  readonly groups: readonly (readonly number[])[];
  readonly unitMass: Float64Array;
  readonly attachmentEdges: number;
}