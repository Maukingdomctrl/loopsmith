// === remainder.ts ===

/**
 * Loop Sprite Engine — integer grid geometry and the remainder theorem.
 *
 * This module owns every arithmetic fact about *where the cuts go*. Nothing
 * here looks at a single pixel: it is pure lattice geometry over ℤ, which is
 * precisely why it can be reasoned about — and unit-tested — in isolation from
 * occupancy, projections and statistics.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE REMAINDER PROBLEM
 *
 * A sprite sheet of extent E on one axis is to be cut into n frames of EQUAL
 * integer size s. Equality is not an aesthetic preference: the consumer of a
 * sheet is an animation loop that blits a fixed-size rectangle per frame, so a
 * partition with mixed cell sizes is not a sprite sheet at all. Hence
 *
 *      n · s ≤ E,    s ∈ ℤ⁺
 *
 * and the largest admissible cell is s = ⌊E / n⌋, leaving a remainder
 *
 *      ρ = E − n · ⌊E / n⌋ ∈ [0, n).
 *
 * Those ρ pixels cannot be kept. The only questions are (1) where to discard
 * them and (2) whether discarding them is legitimate at all.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * (1) WHERE: THE SYMMETRIC SPLIT
 *
 * Writing the crop as (a, b) with a + b = ρ, a ≥ 0, b ≥ 0, the grid origin
 * becomes a and the phase of every cut shifts by a. Choosing a = 0 (crop the
 * far edge only) biases the whole parse toward the low edge by up to ρ pixels;
 * on a sheet whose true gutters are symmetric this misaligns every seam and
 * can flip a P2 decision. The split minimising the worst-case phase error,
 *
 *      a = ⌊ρ/2⌋,   b = ⌈ρ/2⌉ = ρ − a,
 *
 * is the unique solution of min max(a, b) subject to a ≤ b, giving a phase
 * error of at most ⌈ρ/2⌉ ≤ ⌈(n−1)/2⌉ regardless of where the true origin lies.
 * This is the ONLY place in the engine where content is discarded, and it is
 * expressed as a non-zero grid ORIGIN over the untouched source image — never
 * as a resampled intermediate — so the slicer still reads original pixels and
 * interpolation remains impossible by construction.
 *
 * Note what we deliberately do NOT do: distribute ρ by giving ρ of the cells
 * size s+1 (the "Bresenham grid"). That parse has a lower total pixel loss but
 * produces frames of two different sizes, which the animation contract forbids.
 * Genuinely non-uniform sheets are served by the opt-in irregular cut vectors
 * built by `gridFromCuts`, where the cut positions are *measured* rather than
 * synthesised from a pitch.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * (2) WHETHER: ADMISSIBILITY
 *
 * Cropping ρ pixels off an axis shifts the content of every cell relative to
 * its frame by up to ⌈ρ/2⌉. What matters is not the absolute loss but the loss
 * *relative to a cell*, because that is the quantity a viewer perceives as
 * jitter when the frames are played back. So the clean bound is relative:
 *
 *      ρ · 1000 ≤ β · s          (β = config.remainderPermille, default 20‰)
 *
 * With the default β, a 64 px cell tolerates ρ ≤ 1 and an 8 px cell tolerates
 * only ρ = 0 — exactly the scaling one wants, and nothing like a fixed pixel
 * constant that is simultaneously too strict for large sheets and too lax for
 * small ones.
 *
 * Beyond that bound a plan is `lossy`: still structurally usable, but it must
 * be corroborated by strong seam evidence before it may win. That gate lives
 * in `remainderAccepted`, which takes the candidate's seam contrast κ and
 * demands κ ≥ config.lossyContrastFloor. The order of the conjunction matters:
 * a large remainder is acceptable when the gutters are unmistakable (a sheet
 * with a stray 9 px footer), and never acceptable on the strength of geometry
 * alone (the 38×57 parse of a photograph, whose κ is ≈ 0).
 *
 * The hard cap is min(config.maxRemainder, cellSize − 1). The second term is
 * the principled half: if ρ ≥ s you have discarded a whole frame's worth of
 * strip, which means the division count n was never a plausible description of
 * this axis in the first place, and no amount of seam evidence should rescue
 * it. The first term is the ordinary configured ceiling. Taking the min of the
 * two keeps the bound meaningful at both ends of the scale: it is the relative
 * test that binds on large cells and the structural test that binds on small ones.
 */

import {
  DEFAULT_SPRITE_CONFIG,
  type RemainderPlan,
  type SpriteEngineConfig,
  type SpriteGrid,
} from "./types";

/**
 * Plan the division of one axis into `divisions` equal integer cells.
 *
 * Total for every input: a degenerate extent or division count yields a plan
 * with `cellSize = 0` and `admissible = false` rather than throwing, so the
 * candidate sieve can reject it through the ordinary path.
 */
export function planRemainder(
  extent: number,
  divisions: number,
  config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
): RemainderPlan {
  if (
    !Number.isInteger(extent) ||
    !Number.isInteger(divisions) ||
    extent <= 0 ||
    divisions <= 0
  ) {
    return {
      extent: extent > 0 ? extent : 0,
      divisions: divisions > 0 ? divisions : 0,
      cellSize: 0,
      remainder: 0,
      cropLow: 0,
      cropHigh: 0,
      admissible: false,
      lossy: false,
    };
  }

  const cellSize = Math.floor(extent / divisions);
  if (cellSize <= 0) {
    return {
      extent,
      divisions,
      cellSize: 0,
      remainder: extent,
      cropLow: 0,
      cropHigh: 0,
      admissible: false,
      lossy: false,
    };
  }

  const remainder = extent - divisions * cellSize;
  const cropLow = remainder >> 1;
  const cropHigh = remainder - cropLow;

  // Relative bound: ρ·1000 ≤ β·s.
  const withinRelative = remainder * 1000 <= config.remainderPermille * cellSize;
  // Hard cap: the configured ceiling, and never a whole cell's worth.
  const hardCap = Math.min(config.maxRemainder, cellSize - 1);
  const withinHardCap = remainder <= hardCap;

  return {
    extent,
    divisions,
    cellSize,
    remainder,
    cropLow,
    cropHigh,
    admissible: withinRelative || withinHardCap,
    lossy: !withinRelative && withinHardCap,
  };
}

/**
 * Final gate on a plan, given the candidate's seam contrast.
 *
 * A clean plan passes unconditionally. A lossy plan — one that exceeded the
 * relative bound but stayed under the hard cap — passes only when the gutters
 * are unmistakable, i.e. κ ≥ `lossyContrastFloor`. The conjunction is ordered
 * deliberately: strong evidence may excuse a large remainder, but geometry
 * alone never may.
 */
export function remainderAccepted(
  plan: RemainderPlan,
  contrast: number,
  config: SpriteEngineConfig = DEFAULT_SPRITE_CONFIG
): boolean {
  if (!plan.admissible) return false;
  if (!plan.lossy) return true;
  return contrast >= config.lossyContrastFloor;
}

/** Total pixels discarded by a pair of axis plans. Diagnostics and ranking. */
export function discardedPixels(
  planX: RemainderPlan,
  planY: RemainderPlan
): number {
  return planX.remainder + planY.remainder;
}

/**
 * Cut vector for one axis: origin + k·cellSize, k = 0..divisions.
 *
 * Strictly increasing by construction because cellSize ≥ 1, so the result
 * always satisfies `validateGrid`'s monotonicity requirement.
 */
export function buildCuts(
  origin: number,
  cellSize: number,
  divisions: number
): number[] {
  const cuts: number[] = [];
  for (let k = 0; k <= divisions; k++) cuts.push(origin + k * cellSize);
  return cuts;
}

/**
 * Assemble a uniform grid from two axis plans' worth of geometry.
 *
 * The cut vectors are ABSOLUTE original-image coordinates, so
 * `cutsX[0] === originX`. Downstream consumers read the cut vectors and never
 * the pitch, which is what lets uniform and irregular grids share one code
 * path in ownership and in the slicer.
 */
export function uniformGrid(
  cols: number,
  rows: number,
  cellWidth: number,
  cellHeight: number,
  originX: number,
  originY: number
): SpriteGrid {
  return {
    cols,
    rows,
    cellWidth,
    cellHeight,
    originX,
    originY,
    cutsX: buildCuts(originX, cellWidth, cols),
    cutsY: buildCuts(originY, cellHeight, rows),
    uniform: true,
  };
}

/** Convenience: build the uniform grid implied by two remainder plans. */
export function gridFromPlans(
  planX: RemainderPlan,
  planY: RemainderPlan
): SpriteGrid {
  return uniformGrid(
    planX.divisions,
    planY.divisions,
    planX.cellSize,
    planY.cellSize,
    planX.cropLow,
    planY.cropLow
  );
}

/**
 * Build a grid from MEASURED cut vectors, for the opt-in irregular case.
 *
 * `cellWidth` / `cellHeight` are reported as the MODAL cell extent — the most
 * frequent observed size, ties resolving to the smaller — because for an
 * irregular grid there is no pitch, and the modal value is the only summary
 * that is both integer and actually realised by some cell. Consumers that need
 * exact geometry must read the cut vectors; this field is for display.
 */
export function gridFromCuts(
  cutsX: readonly number[],
  cutsY: readonly number[]
): SpriteGrid {
  const cols = cutsX.length - 1;
  const rows = cutsY.length - 1;

  const modal = (cuts: readonly number[], divisions: number): number => {
    if (divisions <= 0) return 0;
    const counts = new Map<number, number>();
    for (let i = 0; i < divisions; i++) {
      const size = cuts[i + 1] - cuts[i];
      counts.set(size, (counts.get(size) ?? 0) + 1);
    }
    let bestSize = cuts[1] - cuts[0];
    let bestCount = -1;
    counts.forEach((count, size) => {
      if (count > bestCount || (count === bestCount && size < bestSize)) {
        bestCount = count;
        bestSize = size;
      }
    });
    return bestSize;
  };

  const cellWidth = modal(cutsX, cols);
  const cellHeight = modal(cutsY, rows);

  let uniform = true;
  for (let i = 0; i < cols; i++) {
    if (cutsX[i + 1] - cutsX[i] !== cellWidth) {
      uniform = false;
      break;
    }
  }
  if (uniform) {
    for (let i = 0; i < rows; i++) {
      if (cutsY[i + 1] - cutsY[i] !== cellHeight) {
        uniform = false;
        break;
      }
    }
  }

  return {
    cols,
    rows,
    cellWidth,
    cellHeight,
    originX: cols > 0 ? cutsX[0] : 0,
    originY: rows > 0 ? cutsY[0] : 0,
    cutsX: cutsX.slice(),
    cutsY: cutsY.slice(),
    uniform,
  };
}

/** Total pixels the grid actually covers. */
export function gridCoverage(grid: SpriteGrid): number {
  const spanX = grid.cutsX[grid.cols] - grid.cutsX[0];
  const spanY = grid.cutsY[grid.rows] - grid.cutsY[0];
  return spanX * spanY;
}