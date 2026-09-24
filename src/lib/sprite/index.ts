// === index.ts ===

/**
 * Loop Sprite Engine — public entry point and pipeline sequencer.
 *
 * This module owns three things and nothing else:
 *
 *   1. The drop-in API surface (`detectSpriteGrid`, `sliceSpriteSheet`).
 *   2. The ORDER in which stages run, which is the only place where the
 *      pipeline's control flow is visible in one piece.
 *   3. Input validation and config normalisation, so that every downstream
 *      module may assume a well-formed `SpriteEngineConfig` and a well-formed
 *      `ImageData` and never re-check.
 *
 * It deliberately contains no geometry, no statistics and no pixel loops. If a
 * change to this file requires arithmetic, the change belongs in one of the
 * stage modules instead.
 *
 * ── Pipeline order ────────────────────────────────────────────────────────────
 *
 *   ImageData → Occupancy → Profiles → Separatrix → Period → Candidates
 *             → Ownership → Ranking → Remainder → Slice → Frames[]
 *
 * ── Module contracts consumed here ───────────────────────────────────────────
 *
 *   ./occupancy   buildOccupancy(image, config) → OccupancyField
 *   ./profiles    buildProfiles(field, config) → ProjectionProfiles
 *   ./separatrix  extractGaps(profile, threshold, minWidth) → GapInterval[]
 *                 evaluateSeams(profile, cuts, profiles, config) → SeamEvidence
 *   ./period      estimatePeriod(profile, gaps, config) → PeriodEstimate
 *                 NO_PERIOD: PeriodEstimate
 *   ./candidates  generateCandidates(profiles, periodX, periodY, config) → GridCandidate[]
 *                 withOwnership(candidate, report, rejection) → GridCandidate
 *   ./ownership   labelComponents(field, config) → ComponentLabelling
 *                 groupUnits(labelling, config) → UnitGrouping
 *                 buildOwnershipReport(field, grid, labelling, grouping, config) → OwnershipReport
 *                 ownershipRejection(report) → RejectionReason | null
 *   ./ranking     rankCandidates(candidates) → GridCandidate[]
 *                 selectWinner(candidates) → GridCandidate | null
 *                 topCandidates(candidates, n) → GridCandidate[]
 *   ./slice       sliceImageData(image, grid, options) → SliceSheetResult
 *                 sliceSheet(source, grid, options) → Promise<SliceSheetResult>
 *
 * ── Determinism ──────────────────────────────────────────────────────────────
 *
 * Nothing in this file performs transcendental arithmetic, allocates in a
 * data-dependent order, or reads a clock or RNG. Candidate ordering is a total
 * order supplied by `compareCandidates`, so `Array.prototype.sort` cannot
 * expose engine-specific tie-breaking. Given identical `ImageData` bytes and
 * identical config, `detectSpriteGrid` returns byte-identical results on every
 * conforming JavaScript engine.
 */

import {
  DEFAULT_SPRITE_CONFIG,
  type DetectionConfidence,
  type DetectionDiagnostics,
  type DetectionResult,
  type GridCandidate,
  type OccupancyField,
  type RejectionReason,
  type SpriteEngineConfig,
  type SpriteGrid,
} from "./types";
import { buildOccupancy } from "./occupancy";
import { buildProfiles } from "./profiles";
import { extractGaps } from "./separatrix";
import { NO_PERIOD, estimatePeriod } from "./period";
import { generateCandidates, withOwnership } from "./candidates";
import {
  buildOwnershipReport,
  groupUnits,
  labelComponents,
  ownershipRejection,
} from "./ownership";
import { rankCandidates, selectWinner, topCandidates } from "./ranking";
import {
  DEFAULT_SLICE_OPTIONS,
  SliceError,
  sliceImageData,
  sliceSheet,
  revokeSliceUrls,
  type SliceOptions,
  type SliceSheetResult,
  type SpriteSlice,
} from "./slice";

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports: everything a consumer legitimately needs, and nothing internal.
// ─────────────────────────────────────────────────────────────────────────────

export * from "./types";
export { buildOccupancy } from "./occupancy";
export { buildProfiles, otsuThreshold, profileStats } from "./profiles";
export { evaluateSeams, extractGaps, gapCenters, seamsPass } from "./separatrix";
export { estimatePeriod, periodFromAutocorrelation, periodFromGaps } from "./period";
export { generateCandidates, generateShapes } from "./candidates";
export { buildOwnershipReport, groupUnits, labelComponents } from "./ownership";
export { compareCandidates, rankCandidates, selectWinner } from "./ranking";
export {
  buildCuts,
  discardedPixels,
  gridFromCuts,
  gridFromPlans,
  planRemainder,
  remainderAccepted,
  uniformGrid,
} from "./remainder";
export {
  DEFAULT_SLICE_OPTIONS,
  SliceError,
  decodeToImageData,
  enumerateCells,
  revokeSliceUrls,
  sliceImageData,
  sliceSheet,
  validateGrid,
  type SliceOptions,
  type SliceSheetResult,
  type SpriteSlice,
} from "./slice";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Clamp to an integer in [lo, hi]. Uses only exact float64 operations. */
function clampInt(value: number, lo: number, hi: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const truncated = Math.floor(value);
  if (truncated < lo) return lo;
  if (truncated > hi) return hi;
  return truncated;
}

/** Clamp to a finite float64 in [lo, hi]. */
function clampReal(value: number, lo: number, hi: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function clampFlag(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Merge a partial override into the defaults, clamping every field into its
 * admissible range.
 *
 * Clamping rather than throwing is right for the numeric knobs: an out-of-range
 * value from a serialised config should degrade gracefully, not crash the
 * editor on import. Structural errors (wrong type) fall back to the default.
 */
export function mergeConfig(
  override: Partial<SpriteEngineConfig> = {}
): SpriteEngineConfig {
  const d = DEFAULT_SPRITE_CONFIG;
  return {
    alphaTransparentPermille: clampInt(override.alphaTransparentPermille ?? d.alphaTransparentPermille, 0, 1000, d.alphaTransparentPermille),
    alphaTranslucentPermille: clampInt(override.alphaTranslucentPermille ?? d.alphaTranslucentPermille, 0, 1000, d.alphaTranslucentPermille),
    borderUniformPermille: clampInt(override.borderUniformPermille ?? d.borderUniformPermille, 0, 1000, d.borderUniformPermille),
    contrastScalePermille: clampInt(override.contrastScalePermille ?? d.contrastScalePermille, 1, 1000, d.contrastScalePermille),
    gradientFallback: clampFlag(override.gradientFallback, d.gradientFallback),
    minInkLevel: clampInt(override.minInkLevel ?? d.minInkLevel, 0, 255, d.minInkLevel),
    cellOccupancyPermille: clampInt(override.cellOccupancyPermille ?? d.cellOccupancyPermille, 0, 1000, d.cellOccupancyPermille),
    smoothingPasses: clampInt(override.smoothingPasses ?? d.smoothingPasses, 0, 8, d.smoothingPasses),
    seamRadius: clampInt(override.seamRadius ?? d.seamRadius, 0, 8, d.seamRadius),
    significanceAlpha: clampReal(override.significanceAlpha ?? d.significanceAlpha, 0.0001, 0.1, d.significanceAlpha),
    minGapWidth: clampInt(override.minGapWidth ?? d.minGapWidth, 1, 64, d.minGapWidth),
    minCellSize: clampInt(override.minCellSize ?? d.minCellSize, 1, 512, d.minCellSize),
    maxDivisions: clampInt(override.maxDivisions ?? d.maxDivisions, 2, 256, d.maxDivisions),
    maxFrames: clampInt(override.maxFrames ?? d.maxFrames, 2, 65536, d.maxFrames),
    remainderPermille: clampInt(override.remainderPermille ?? d.remainderPermille, 0, 1000, d.remainderPermille),
    maxRemainder: clampInt(override.maxRemainder ?? d.maxRemainder, 0, 256, d.maxRemainder),
    lossyContrastFloor: clampReal(override.lossyContrastFloor ?? d.lossyContrastFloor, 0, 1, d.lossyContrastFloor),
    maxLeakageNumerator: clampInt(override.maxLeakageNumerator ?? d.maxLeakageNumerator, 1, 1000, d.maxLeakageNumerator),
    maxLeakageDenominator: clampInt(override.maxLeakageDenominator ?? d.maxLeakageDenominator, 1, 1000, d.maxLeakageDenominator),
    attachDistancePermille: clampInt(override.attachDistancePermille ?? d.attachDistancePermille, 0, 1000, d.attachDistancePermille),
    massRatioNumerator: clampInt(override.massRatioNumerator ?? d.massRatioNumerator, 1, 1000, d.massRatioNumerator),
    massRatioDenominator: clampInt(override.massRatioDenominator ?? d.massRatioDenominator, 1, 1000, d.massRatioDenominator),
    dustPermille: clampInt(override.dustPermille ?? d.dustPermille, 0, 1000, d.dustPermille),
    minOccupiedPermille: clampInt(override.minOccupiedPermille ?? d.minOccupiedPermille, 0, 1000, d.minOccupiedPermille),
    requireEmptySuffix: clampFlag(override.requireEmptySuffix, d.requireEmptySuffix),
    maxComponents: clampInt(override.maxComponents ?? d.maxComponents, 1, 65536, d.maxComponents),
    maxOwnershipEvaluations: clampInt(override.maxOwnershipEvaluations ?? d.maxOwnershipEvaluations, 1, 256, d.maxOwnershipEvaluations),
    minAutocorrelationStrength: clampReal(override.minAutocorrelationStrength ?? d.minAutocorrelationStrength, 0, 1, d.minAutocorrelationStrength),
    scoreQuantum: clampReal(override.scoreQuantum ?? d.scoreQuantum, 1, 1e12, d.scoreQuantum),
    allowIrregular: clampFlag(override.allowIrregular, d.allowIrregular),
    maxPixels: clampInt(override.maxPixels ?? d.maxPixels, 1, 2e9, d.maxPixels),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A sprite sheet must contain at least two frames.
 *
 * A 1×1 "grid" passes every predicate vacuously — there are no interior seams
 * to test and no neighbouring cell to leak into — so a bug anywhere upstream
 * could otherwise surface a photograph as a one-frame sheet. Enforcing the
 * floor here means that outcome is unreachable regardless of what
 * `candidates.ts` believes.
 */
const MIN_FRAMES = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

const NO_GRID_DIAGNOSTICS = (
  occupancy: OccupancyField,
  reason: RejectionReason
): DetectionDiagnostics => ({
  occupancy: occupancy.kind,
  background: occupancy.background,
  noiseFloor: occupancy.noiseFloor,
  totalMass: occupancy.totalMass,
  periodX: NO_PERIOD,
  periodY: NO_PERIOD,
  shapesGenerated: 0,
  seamPassed: 0,
  ownershipEvaluated: 0,
  componentCount: 0,
  unitCount: 0,
  phaseUnidentifiable: false,
  rejectedSample: [],
});

/**
 * Confidence label for a winning candidate.
 *
 * "exact" is reserved for a phase-identified parse with zero remainder on both
 * axes and non-vacuous, significant seams. A period-only parse can never be
 * better than "period-only" however clean it looks, because it does not know
 * where the frames begin.
 */
function classifyConfidence(candidate: GridCandidate): DetectionConfidence {
  if (candidate.phaseUnidentifiable) return "period-only";
  if (candidate.remainderX.lossy || candidate.remainderY.lossy) return "lossy";
  if (
    candidate.remainderX.remainder === 0 &&
    candidate.remainderY.remainder === 0
  ) {
    return "exact";
  }
  return "high";
}

/** The reason to report when nothing was accepted: the best loser's reason. */
function dominantRejection(ranked: readonly GridCandidate[]): RejectionReason {
  for (let i = 0; i < ranked.length; i++) {
    const reason = ranked[i].rejection;
    if (reason !== null) return reason;
  }
  return "no-content";
}

// ─────────────────────────────────────────────────────────────────────────────
// Core detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect the sprite grid of an image, with full diagnostics.
 *
 * Total: every failure path returns a `DetectionResult` with `grid === null`
 * and a `rejection`, so callers never need a try/catch around detection.
 */
export function detectSpriteGridDetailed(
  image: ImageData,
  config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
): DetectionResult {
  const occupancy = buildOccupancy(image, config);

  if (
    occupancy.width <= 0 ||
    occupancy.height <= 0 ||
    occupancy.occupiedCount === 0
  ) {
    return {
      grid: null,
      frameCount: 0,
      confidence: "rejected",
      candidate: null,
      rejection: "no-content",
      diagnostics: NO_GRID_DIAGNOSTICS(occupancy, "no-content"),
    };
  }

  const profiles = buildProfiles(occupancy, config);

  const gapsX = extractGaps(
    profiles.smoothedColumns,
    profiles.columnThreshold,
    config.minGapWidth
  );
  const gapsY = extractGaps(
    profiles.smoothedRows,
    profiles.rowThreshold,
    config.minGapWidth
  );

  const periodX = estimatePeriod(profiles.smoothedColumns, gapsX, config);
  const periodY = estimatePeriod(profiles.smoothedRows, gapsY, config);

    
  // >>> TEMP DIAGNOSTIC — remove after diagnosis <<<
  console.log("DIM", profiles.width, profiles.height);
  console.log("PERIOD X", periodX);
  console.log("PERIOD Y", periodY);
  console.log("X GAPS", gapsX.map(g => ({c: g.center, w: g.width, mean: g.meanValue, border: g.border})));
  console.log("Y GAPS", gapsY.map(g => ({c: g.center, w: g.width, mean: g.meanValue, border: g.border})));
  console.log("X thresh", profiles.columnThreshold, "sm passes", config.smoothingPasses);

 

  const generated = generateCandidates(profiles, periodX, periodY, config);
  const seamPassed = generated.filter((c) => c.accepted);

  // The unit partition is grid-independent, so it is computed once and shared
  // by every candidate. That is what makes candidates comparable at all.
  const labelling = labelComponents(occupancy, config);
  const grouping = groupUnits(labelling, config);

  const shortlist = topCandidates(seamPassed, config.maxOwnershipEvaluations);
  const shortlistKeys = new Set(
    shortlist.map(
      (c) =>
        `${c.grid.cols}x${c.grid.rows}@${c.grid.originX},${c.grid.originY}`
    )
  );

  const evaluated: GridCandidate[] = [];
  let ownershipEvaluated = 0;

  for (let i = 0; i < generated.length; i++) {
    const candidate = generated[i];
    const key = `${candidate.grid.cols}x${candidate.grid.rows}@${candidate.grid.originX},${candidate.grid.originY}`;

    if (!candidate.accepted || !shortlistKeys.has(key)) {
      evaluated.push(candidate);
      continue;
    }

    const report = buildOwnershipReport(
      occupancy,
      candidate.grid,
      labelling,
      grouping,
      config
    );
    ownershipEvaluated++;
    evaluated.push(withOwnership(candidate, report, ownershipRejection(report)));
  }

  const ranked = rankCandidates(evaluated);
  const winner = selectWinner(evaluated);

  const diagnostics: DetectionDiagnostics = {
    occupancy: occupancy.kind,
    background: occupancy.background,
    noiseFloor: occupancy.noiseFloor,
    totalMass: occupancy.totalMass,
    periodX,
    periodY,
    shapesGenerated: generated.length,
    seamPassed: seamPassed.length,
    ownershipEvaluated,
    componentCount: labelling.components.length,
    unitCount: grouping.groups.length,
    phaseUnidentifiable:
      periodX.method === "autocorrelation" ||
      periodY.method === "autocorrelation",
    rejectedSample: ranked.filter((c) => !c.accepted).slice(0, 8),
  };

  if (winner === null) {
    return {
      grid: null,
      frameCount: 0,
      confidence: "rejected",
      candidate: null,
      rejection: dominantRejection(ranked),
      diagnostics,
    };
  }

  // Defence-in-depth: a 1×1 grid passes predicates vacuously.
  if (winner.grid.cols * winner.grid.rows < MIN_FRAMES) {
    return {
      grid: null,
      frameCount: 0,
      confidence: "rejected",
      candidate: winner,
      rejection: "no-content",
      diagnostics,
    };
  }

  return {
    grid: winner.grid,
    frameCount: winner.grid.cols * winner.grid.rows,
    confidence: classifyConfidence(winner),
    candidate: winner,
    rejection: null,
    diagnostics,
  };
}

/**
 * Convenience entry point: the grid, or null when the image is not a sheet.
 *
 * This is the signature the editor's import path consumes. Returning null for
 * a photograph is the whole contract: a single-frame import must never be
 * shredded into hundreds of fragments.
 */
export function detectSpriteGrid(
  image: ImageData,
  config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
): SpriteGrid | null {
  const result = detectSpriteGridDetailed(image, config);
  if (result.grid === null) return null;
  if (result.grid.cols * result.grid.rows < MIN_FRAMES) return null;
  return result.grid;
}

/**
 * Detect and slice in one call.
 *
 * Detection runs on the decoded `ImageData` and slicing reuses the very same
 * buffer, so the grid can never be measured on one lattice and applied to
 * another — the `grid-mismatch` failure is unreachable through this path.
 */
export async function extractFrames(
  source: Blob | ImageData | ImageBitmap,
  config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG,
  options: Partial<SliceOptions> = {}
): Promise<{ detection: DetectionResult; slices: SliceSheetResult | null }> {
  const opts: SliceOptions = { ...DEFAULT_SLICE_OPTIONS, ...options };
  const { decodeToImageData } = await import("./slice");
  const image = await decodeToImageData(source, opts.maxPixels);

  const detection = detectSpriteGridDetailed(image, config);
  if (detection.grid === null) {
    return { detection, slices: null };
  }

  const slices =
    opts.encode || opts.createUrls
      ? await sliceSheet(image, detection.grid, opts)
      : sliceImageData(image, detection.grid, opts);

  return { detection, slices };
}

/**
 * Data-URL frames, in scan order — the shape the editor's timeline stores.
 *
 * Compatible with the existing `sliceSpriteSheet(file, grid)` call in the
 * editor's import path. The source can be a Blob (File), ImageData, or
 * ImageBitmap; the grid comes from `detectSpriteGrid`.
 */
export async function sliceSpriteSheet(
  source: Blob | ImageData | ImageBitmap,
  grid: SpriteGrid,
  options: Partial<SliceOptions> = {}
): Promise<string[]> {
  const result = await sliceSheet(source, grid, {
    ...options,
    encode: true,
    createUrls: false,
  });

  const urls: string[] = [];
  for (let i = 0; i < result.slices.length; i++) {
    const blob = result.slices[i].blob;
    if (blob === null) {
      throw new SliceError("encode-failed", result.slices[i].name);
    }
    urls.push(await blobToDataUrl(blob));
  }
  return urls;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = reader.result;
      if (typeof value === "string") resolve(value);
      else
        reject(
          new SliceError("encode-failed", "reader returned non-string")
        );
    };
    reader.onerror = () =>
      reject(new SliceError("encode-failed", String(reader.error)));
    reader.readAsDataURL(blob);
  });
}

