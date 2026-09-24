// === ranking.ts ===

/**
 * Loop Sprite Engine — deterministic total ordering of candidates.
 *
 * Two properties are non-negotiable:
 *
 *   TOTALITY.  `compareCandidates` returns 0 only for candidates that are
 *   indistinguishable in EVERY tie-break, the last of which is the grid shape
 *   itself. Two distinct grids therefore always have a strict order.
 *
 *   STABILITY-INDEPENDENCE.  Nothing here relies on `Array.prototype.sort`
 *   being stable. The specification has guaranteed stability since ES2019, but
 *   relying on it would mean the winner depends on generation order, and
 *   generation order is exactly the kind of hidden state that let a 38×57 grid
 *   win a race it should have lost. `rankCandidates` sorts with a comparator
 *   that cannot return 0 for distinct inputs.
 *
 * ORDER OF CRITERIA, and why:
 *
 *   0. ACCEPTANCE dominates every quality measure. A rejected candidate never
 *      beats an accepted one, regardless of score.
 *
 *   0b. PHASE IDENTIFICATION. A phase-identified parse always beats a
 *      period-only one: the latter cannot state where the frames begin, only
 *      how wide they are, and that ambiguity is surfaced to the user rather
 *      than silently resolved by the engine.
 *
 *   1. SEAM QUALITY (the quantised score Φ). Φ already folds in both axes'
 *      contrast and the parsimony penalty, so it is the primary evidence that
 *      the cuts are real. Quantisation makes its comparison exact.
 *
 *   2. OWNERSHIP QUALITY. Lower maximum leakage first, then more principal
 *      units. Leakage precedes count because a parse that splits a sprite is
 *      wrong no matter how many sprites it claims to have found.
 *
 *   3. REMAINDER QUALITY. Less discarded content first; a clean division beats
 *      a cropped one at equal evidence.
 *
 *   4. AREA. Larger cells first at equal everything else, i.e. prefer the
 *      COARSER parse. This is the tie-break that resolves the 2× ambiguity
 *      when a sheet's sprites genuinely do not straddle the extra cuts, and it
 *      follows the same minimum-description-length logic as the parsimony term.
 *
 *   5. SHAPE. Final lexicographic tie-break on (rows, cols, originY, originX)
 *      that makes the order TOTAL so the result never depends on generation
 *      order or sort stability.
 */

import type { GridCandidate } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Accepted candidates sort before rejected ones, always. */
function acceptanceRank(c: GridCandidate): number {
  return c.accepted ? 0 : 1;
}

function totalRemainder(c: GridCandidate): number {
  return c.remainderX.remainder + c.remainderY.remainder;
}

function lossyRank(c: GridCandidate): number {
  return (c.remainderX.lossy ? 1 : 0) + (c.remainderY.lossy ? 1 : 0);
}

function cellArea(c: GridCandidate): number {
  return c.grid.cellWidth * c.grid.cellHeight;
}

/**
 * Max leakage, with "no ownership report" treated as maximally bad.
 *
 * A candidate that never received an ownership pass sorts after one that did,
 * which is the correct asymmetry: we evaluated the shortlist precisely because
 * we expected them to pass, and a candidate we did not evaluate is evidence-
 * free rather than evidence-good.
 */
function leakage(c: GridCandidate): number {
  return c.ownership === null ? 1 : c.ownership.maxLeakage;
}

function principalUnits(c: GridCandidate): number {
  return c.ownership === null ? 0 : c.ownership.principalUnitCount;
}

// ---------------------------------------------------------------------------
// Total order
// ---------------------------------------------------------------------------

/**
 * Canonical order: better candidates compare LESS, so `sort(compare)` puts the
 * winner at index 0.
 *
 * Returns 0 only when both candidates are identical in every field tested here.
 * In practice the final shape tie-break (rows, cols, originY, originX) makes
 * this impossible for two distinct grids.
 */
export function compareCandidates(a: GridCandidate, b: GridCandidate): number {
  // 0. Acceptance dominates every quality measure.
  const acceptance = acceptanceRank(a) - acceptanceRank(b);
  if (acceptance !== 0) return acceptance;

  // 0b. Phase-identified parse beats period-only.
  const phase =
    (a.phaseUnidentifiable ? 1 : 0) - (b.phaseUnidentifiable ? 1 : 0);
  if (phase !== 0) return phase;

  // 1. Seam quality: higher quantised score first. Integers, exact.
  if (a.score !== b.score) return b.score - a.score;

  // 2. Ownership quality: lower leakage first, then more principal units.
  const la = leakage(a);
  const lb = leakage(b);
  if (la !== lb) return la < lb ? -1 : 1;

  const pa = principalUnits(a);
  const pb = principalUnits(b);
  if (pa !== pb) return pb - pa;

  // 3. Remainder quality: fewer lossy axes, then fewer discarded pixels.
  const lossy = lossyRank(a) - lossyRank(b);
  if (lossy !== 0) return lossy;

  const rem = totalRemainder(a) - totalRemainder(b);
  if (rem !== 0) return rem;

  // 4. Area: prefer the coarser parse.
  const area = cellArea(b) - cellArea(a);
  if (area !== 0) return area;

  // 5. Shape tie-breaks. These make the order TOTAL, so the result never
  //    depends on the sort's stability or on generation order.
  if (a.grid.rows !== b.grid.rows) return a.grid.rows - b.grid.rows;
  if (a.grid.cols !== b.grid.cols) return a.grid.cols - b.grid.cols;
  if (a.grid.originY !== b.grid.originY) return a.grid.originY - b.grid.originY;
  if (a.grid.originX !== b.grid.originX) return a.grid.originX - b.grid.originX;
  return 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Canonically ordered copy. The input array is never mutated. */
export function rankCandidates(
  candidates: readonly GridCandidate[]
): GridCandidate[] {
  return candidates.slice().sort(compareCandidates);
}

/**
 * The winner, or null when nothing was accepted.
 *
 * Linear scan rather than sort: we only need the minimum, and a sort that is
 * discarded immediately wastes O(n log n) comparisons. The comparator is still
 * the authority on ordering — we are just using it as a min predicate.
 */
export function selectWinner(
  candidates: readonly GridCandidate[]
): GridCandidate | null {
  let best: GridCandidate | null = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c.accepted) continue;
    if (best === null || compareCandidates(c, best) < 0) best = c;
  }
  return best;
}

/**
 * The `limit` best candidates by canonical order, regardless of acceptance.
 *
 * Used to choose which seam-passing candidates receive the O(WH) ownership
 * pass, and to fill `diagnostics.rejectedSample`. A negative limit returns an
 * empty array rather than throwing.
 */
export function topCandidates(
  candidates: readonly GridCandidate[],
  limit: number
): GridCandidate[] {
  if (limit <= 0) return [];
  const ranked = rankCandidates(candidates);
  return ranked.slice(0, limit);
}