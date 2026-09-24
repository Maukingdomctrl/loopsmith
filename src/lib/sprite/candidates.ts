// === candidates.ts ===

/**
 * Loop Sprite Engine — hypothesis generation.
 *
 * Turns period estimates into a finite, deduplicated set of GridCandidates and
 * decides the purely geometric rejections. It does NOT verify ownership and it
 * does NOT rank: both would require it to know about the winner, and a
 * generator that knows about the winner is a generator that can be biased by
 * evaluation order.
 *
 * Generation strategy, in decreasing order of evidence:
 *
 *   1. The divisions implied by each axis' period estimate, plus its immediate
 *      integer neighbours. Neighbours matter because `divisions` is a rounded
 *      quotient and a sheet with wide outer margins can round the wrong way.
 *   2. The single-division parse on each axis, so an N×1 strip is reachable.
 *   3. Small exact divisors of the extent, which catch sheets whose gutters are
 *      zero-width on one axis only.
 *
 * Every shape then passes the geometric sieve — minimum cell size, division
 * cap, frame budget, remainder admissibility — before any statistic is
 * computed, because the sieve is O(1) per shape and the statistics are not.
 */

import {
  DEFAULT_SPRITE_CONFIG,
  type GridCandidate,
  type GridShape,
  type OwnershipReport,
  type PeriodEstimate,
  type ProjectionProfiles,
  type RejectionReason,
  type SeamEvidence,
  type SpriteEngineConfig,
} from "./types";
import { evaluateSeamsX, evaluateSeamsY, seamsPass } from "./separatrix";
import { planRemainder, remainderAccepted, uniformGrid } from "./remainder";

/**
 * ⌈log₂(v)⌉ by bit length, for v ≥ 1.
 *
 * Integer arithmetic only: `Math.log2(8)` is not guaranteed to be exactly 3 on
 * every engine, and a description length that flickers between 3 and 4 would
 * make the ranking non-deterministic across platforms.
 */
export function ceilLog2(v: number): number {
  if (v <= 1) return 0;
  const bits = 32 - Math.clz32(v - 1);
  return bits;
}

/** Candidate shapes for one axis, ascending, deduplicated. */
export function axisDivisions(
  estimate: PeriodEstimate,
  extent: number,
  config: SpriteEngineConfig
): number[] {
  const seen = new Set<number>();
  const push = (n: number): void => {
    if (!Number.isInteger(n) || n < 1 || n > config.maxDivisions) return;
    if (Math.floor(extent / n) < config.minCellSize) return;
    seen.add(n);
  };

  push(1);

  if (estimate.divisions > 0) {
    push(estimate.divisions - 1);
    push(estimate.divisions);
    push(estimate.divisions + 1);
  }

  if (estimate.period > 0) {
    push(Math.floor(extent / estimate.period));
    push(Math.ceil(extent / estimate.period));
  }

  // Exact divisors: cheap, and they are the only route to a zero-remainder
  // parse when the period estimator has been defeated on this axis.
  for (let n = 2; n <= config.maxDivisions; n++) {
    if (extent % n === 0) push(n);
  }

  const out = Array.from(seen);
  out.sort((a, b) => a - b);
  return out;
}

/** Cartesian product of the two axis lists, in canonical (rows, cols) order. */
export function generateShapes(
  periodX: PeriodEstimate,
  periodY: PeriodEstimate,
  width: number,
  height: number,
  config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
): GridShape[] {
  const colsList = axisDivisions(periodX, width, config);
  const rowsList = axisDivisions(periodY, height, config);

  const shapes: GridShape[] = [];
  for (let r = 0; r < rowsList.length; r++) {
    for (let c = 0; c < colsList.length; c++) {
      const cols = colsList[c];
      const rows = rowsList[r];
      if (cols === 1 && rows === 1) continue; // the whole image is not a sheet
      if (cols * rows > config.maxFrames) continue;
      shapes.push({ cols, rows });
    }
  }
  shapes.sort(
    (a, b) =>
      a.rows * a.cols - b.rows * b.cols || a.rows - b.rows || a.cols - b.cols
  );
  return shapes;
}

/**
 * Quantised objective Φ = κx + κy − parsimony(cols·rows).
 *
 * The parsimony term is the description length in bits, scaled so that one
 * doubling of the frame count costs the same as 1/32 of full seam contrast.
 * Its role is to break the degeneracy by which any accepted grid's 2×
 * refinement also has clean seams: without it, a 4×4 sheet would be parsed as
 * 8×8 whenever the sprite bodies happen not to straddle the extra cuts.
 *
 * The result is rounded onto a lattice of `scoreQuantum` steps, which turns
 * float comparison into a total order and makes ties explicit rather than
 * dependent on the last bit of a sum of divisions.
 */
export function candidateScore(
  seamX: SeamEvidence,
  seamY: SeamEvidence,
  cells: number,
  config: SpriteEngineConfig
): { score: number; descriptionBits: number } {
  const descriptionBits = ceilLog2(cells);
  const raw = seamX.contrast + seamY.contrast - descriptionBits / 32;
  return {
    score: Math.round(raw * config.scoreQuantum),
    descriptionBits,
  };
}

/**
 * Build one fully-evaluated candidate, short of ownership.
 *
 * Rejection order is from cheapest and most fundamental to most expensive, and
 * the FIRST failure is the reported reason — so a 2 px cell reports
 * "cell-too-small" rather than the "seam-insignificant" it would also earn.
 */
export function buildCandidate(
  shape: GridShape,
  profiles: ProjectionProfiles,
  phaseUnidentifiable: boolean,
  config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
): GridCandidate {
  const { cols, rows } = shape;
  const remainderX = planRemainder(profiles.width, cols, config);
  const remainderY = planRemainder(profiles.height, rows, config);

  const grid = uniformGrid(
    cols,
    rows,
    remainderX.cellSize,
    remainderY.cellSize,
    remainderX.cropLow,
    remainderY.cropLow
  );

  const cells = cols * rows;

  let rejection: RejectionReason | null = null;
  if (
    remainderX.cellSize < config.minCellSize ||
    remainderY.cellSize < config.minCellSize
  ) {
    rejection = "cell-too-small";
  } else if (cells > config.maxFrames) {
    rejection = "frame-budget";
  } else if (!remainderX.admissible || !remainderY.admissible) {
    rejection = "remainder-inadmissible";
  }

  const seamX =
    rejection === null || rejection === "remainder-inadmissible"
      ? evaluateSeamsX(profiles, grid.cutsX, cols, config)
      : evaluateSeamsX(profiles, grid.cutsX, 1, config);
  const seamY =
    rejection === null || rejection === "remainder-inadmissible"
      ? evaluateSeamsY(profiles, grid.cutsY, rows, config)
      : evaluateSeamsY(profiles, grid.cutsY, 1, config);

  const contrast = Math.min(
    seamX.vacuous ? 1 : seamX.contrast,
    seamY.vacuous ? 1 : seamY.contrast
  );

  if (rejection === "remainder-inadmissible") {
    // A lossy plan may still be redeemed by unmistakable gutters.
    if (
      remainderAccepted(remainderX, contrast, config) &&
      remainderAccepted(remainderY, contrast, config)
    ) {
      rejection = null;
    }
  }

  if (rejection === null && !phaseUnidentifiable) {
    if (!seamsPass(seamX) || !seamsPass(seamY)) {
      const crossed =
        (!seamX.vacuous && !seamX.separated) ||
        (!seamY.vacuous && !seamY.separated);
      rejection = crossed ? "seam-crossed" : "seam-insignificant";
    }
  }

  const { score, descriptionBits } = candidateScore(seamX, seamY, cells, config);

  return {
    grid,
    remainderX,
    remainderY,
    seamX,
    seamY,
    ownership: null,
    accepted: rejection === null,
    rejection,
    score,
    descriptionBits,
    phaseUnidentifiable,
  };
}

/**
 * Attach an ownership report, producing a NEW candidate.
 *
 * Candidates are immutable by contract: no stage may annotate one in place.
 * That is the structural guarantee that acceptance cannot depend on evaluation
 * history, which is the defect that let a 38×57 grid win on a photograph.
 */
export function withOwnership(
  candidate: GridCandidate,
  ownership: OwnershipReport,
  rejection: RejectionReason | null
): GridCandidate {
  return {
    grid: candidate.grid,
    remainderX: candidate.remainderX,
    remainderY: candidate.remainderY,
    seamX: candidate.seamX,
    seamY: candidate.seamY,
    ownership,
    accepted: rejection === null,
    rejection,
    score: candidate.score,
    descriptionBits: candidate.descriptionBits,
    phaseUnidentifiable: candidate.phaseUnidentifiable,
  };
}

/** Generate every candidate for a sheet, geometric sieve applied. */
export function generateCandidates(
  profiles: ProjectionProfiles,
  periodX: PeriodEstimate,
  periodY: PeriodEstimate,
  config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
): GridCandidate[] {
  const phaseUnidentifiable =
    periodX.method === "autocorrelation" ||
    periodY.method === "autocorrelation";

  const shapes = generateShapes(
    periodX,
    periodY,
    profiles.width,
    profiles.height,
    config
  );
  const candidates: GridCandidate[] = [];
  for (let i = 0; i < shapes.length; i++) {
    candidates.push(
      buildCandidate(shapes[i], profiles, phaseUnidentifiable, config)
    );
  }
  return candidates;
}