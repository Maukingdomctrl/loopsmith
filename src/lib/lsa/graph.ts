/**
 * LSA v1.0 — §B.4.1–B.4.2: the measurement graph.
 *
 * Three of the seven hard constraints are physically realized here, which is
 * why the edge set is built by a RULE and never by a heuristic:
 *
 *  • CYCLICITY (Constraint 5). Λ_N always contains ℓ = 1, so E always contains
 *    the wrap edge (N−1 → 0). Corollary B.8 then distributes the loop-closure
 *    error as exactly −curl/N on EVERY edge including the seam. A chain
 *    formulation dumps the whole closure error on the seam — visible as a jump
 *    on every loop iteration.
 *
 *  • CONNECTIVITY ⇒ UNIQUENESS (Constraint 4, Theorem A.1). The ring alone
 *    guarantees ker 𝓛 = span{𝟙 ⊗ v}, i.e. exactly the gauge freedom of Fact 1
 *    and nothing more. This is why ring edges are PROTECTED from rejection.
 *
 *  • 2 ≤ N ≤ 64 with no special cases. Λ_N = {2^k : 2^k ≤ ⌊N/2⌋} degenerates
 *    correctly: N=2 → {1} → one edge; N=3 → {1} → the triangle; N=24 →
 *    {1,2,4,8} → |E| = 96.
 *
 * The dyadic SKIP edges exist for Lemma B.5 and for no other reason: they drop
 * the effective resistance R_eff(i,j) from O(N) on a bare ring to O(log N),
 * which is what bounds GLOBAL drift across the loop rather than merely local
 * neighbour jitter. Anyone tempted to "simplify" this to a ring should read
 * Lemma B.5 first — for N=64 the ring gives R_eff(0, N/2) = N/4w.
 *
 * Long-lag edges are riskier (content differs more across lag 8 than lag 1) but
 * SELF-POLICING: σ̂² in (B.14) grows, A shrinks, and the edge is discounted by
 * exactly the right factor. No lag-dependent weight is introduced anywhere.
 */

import type {
  ConstraintGraph,
  CycleSpec,
  EdgeSpec,
  FrameIndex,
} from "./types";

/** Λ_N = { 2^k : 2^k ≤ ⌊N/2⌋ } — (B.19). */
export function dyadicLags(frameCount: number): number[] {
  const half = Math.floor(frameCount / 2);
  const lags: number[] = [];
  for (let l = 1; l <= half; l *= 2) lags.push(l);
  return lags.length > 0 ? lags : [1];
}

export function ringLags(): number[] {
  return [1];
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Build E in CANONICAL order: lags ascending, then source index ascending.
 * Edge ids follow that order and fix the accumulation order of the Laplacian
 * assembly — determinism invariant 3 of §1.3.
 */
export function buildEdges(
  frameCount: number,
  topology: "dyadic" | "ring"
): EdgeSpec[] {
  const lags = topology === "ring" ? ringLags() : dyadicLags(frameCount);
  const seen = new Set<string>();
  const edges: EdgeSpec[] = [];

  for (const lag of lags) {
    for (let i = 0; i < frameCount; i++) {
      const j = (i + lag) % frameCount;
      if (i === j) continue;

      // Dedup: at 2ℓ = N the forward and backward edges are the same pair.
      const key = pairKey(i, j);
      if (seen.has(key)) continue;
      seen.add(key);

      edges.push({
        id: edges.length,
        from: i,
        to: j,
        lag,
        isRingEdge: lag === 1,
        // The loop seam. For N = 2 the single edge is kept as (0 → 1) by
        // dedup, so no seam flag is set — there is no distinguishable seam
        // when the graph has one edge.
        isSeamEdge: lag === 1 && i === frameCount - 1,
      });
    }
  }
  return edges;
}

/* ---------- union-find over usable nodes ---------- */

class DisjointSet {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

/** Look up the stored edge for an unordered pair, with its orientation sign. */
export interface SignedEdgeRef {
  readonly id: number;
  readonly sign: 1 | -1;
}

export function buildEdgeLookup(
  edges: readonly EdgeSpec[]
): Map<string, SignedEdgeRef & { from: number; to: number }> {
  const map = new Map<string, SignedEdgeRef & { from: number; to: number }>();
  for (const e of edges) {
    map.set(pairKey(e.from, e.to), {
      id: e.id,
      sign: 1,
      from: e.from,
      to: e.to,
    });
  }
  return map;
}

export function signedEdge(
  lookup: ReturnType<typeof buildEdgeLookup>,
  u: number,
  v: number
): SignedEdgeRef | null {
  const hit = lookup.get(pairKey(u, v));
  if (!hit) return null;
  return { id: hit.id, sign: hit.from === u ? 1 : -1 };
}

/**
 * Build the graph, restricted to frames whose pixels are usable.
 *
 * A blank frame (Loop's createBlankFrame, or α ≡ 0) becomes an ISOLATED node,
 * not an error: §A.5 gives dim ker 𝓛 = number of components, the gauge is
 * imposed per component, and on a singleton 𝓛⁺b yields t_i = 0 — "the
 * minimum-norm and correctly non-committal answer".
 */
export function buildConstraintGraph(
  frameCount: number,
  usable: readonly boolean[],
  topology: "dyadic" | "ring"
): ConstraintGraph {
  const allEdges = buildEdges(frameCount, topology);
  const edges = allEdges
    .filter((e) => usable[e.from] && usable[e.to])
    .map((e, idx) => ({ ...e, id: idx }));

  const nodes: FrameIndex[] = [];
  for (let i = 0; i < frameCount; i++) if (usable[i]) nodes.push(i);

  const incidence = new Map<FrameIndex, number[]>();
  for (const n of nodes) incidence.set(n, []);
  for (const e of edges) {
    incidence.get(e.from)?.push(e.id);
    incidence.get(e.to)?.push(e.id);
  }

  const ds = new DisjointSet(frameCount);
  for (const e of edges) ds.union(e.from, e.to);

  const byRoot = new Map<number, FrameIndex[]>();
  for (const n of nodes) {
    const r = ds.find(n);
    const list = byRoot.get(r);
    if (list) list.push(n);
    else byRoot.set(r, [n]);
  }
  const components = Array.from(byRoot.keys())
    .sort((a, b) => a - b)
    .map((r) => byRoot.get(r)!);

  const cycleRank = edges.length - nodes.length + components.length;
  const cycleBasis = buildCycleFamily(frameCount, edges, topology, usable);

  return {
    frameCount,
    nodes,
    edges,
    incidence,
    components,
    cycleBasis,
    cycleRank,
  };
}

/**
 * The cycle family tested by §B.4.3: the dyadic triangles γ_{i,ℓ} =
 * {(i,i+ℓ), (i+ℓ,i+2ℓ), (i,i+2ℓ)} for every ℓ with 2ℓ ∈ Λ_N, plus the ring
 * cycle.
 *
 * NOTE ON NAMING: this family need not SPAN the cycle space (for N=24 it has 73
 * dimensions and we test 73 cycles, but independence is not enforced). That is
 * deliberate and harmless: (A.5) makes z_γᵀd a valid pure-error functional for
 * EVERY cycle independently, so (B.20) yields a valid χ²₂ statistic per cycle
 * regardless of completeness. Completeness would matter only if we were
 * reconstructing the residual from the curls, which we never do.
 */
function buildCycleFamily(
  frameCount: number,
  edges: readonly EdgeSpec[],
  topology: "dyadic" | "ring",
  usable: readonly boolean[]
): CycleSpec[] {
  const lookup = buildEdgeLookup(edges);
  const lags = topology === "ring" ? ringLags() : dyadicLags(frameCount);
  const lagSet = new Set(lags);
  const cycles: CycleSpec[] = [];

  const push = (refs: (SignedEdgeRef | null)[]): void => {
    if (refs.some((r) => r === null)) return;
    const ids = refs.map((r) => r!.id);
    if (new Set(ids).size !== ids.length) return; // degenerate at small N
    cycles.push({
      id: cycles.length,
      edgeIds: ids,
      signs: refs.map((r) => r!.sign),
    });
  };

  for (const l of lags) {
    if (!lagSet.has(2 * l)) continue;
    for (let i = 0; i < frameCount; i++) {
      const b = (i + l) % frameCount;
      const c = (i + 2 * l) % frameCount;
      if (!usable[i] || !usable[b] || !usable[c]) continue;
      if (i === b || b === c || i === c) continue;
      push([
        signedEdge(lookup, i, b),
        signedEdge(lookup, b, c),
        signedEdge(lookup, c, i),
      ]);
    }
  }

  // The ring cycle. Always included when it exists: it is the cycle whose curl
  // IS the loop-closure error of Corollary B.8, so it is the one the seam
  // depends on.
  if (frameCount >= 3 && usable.every((u) => u)) {
    const refs: (SignedEdgeRef | null)[] = [];
    for (let i = 0; i < frameCount; i++) {
      refs.push(signedEdge(lookup, i, (i + 1) % frameCount));
    }
    push(refs);
  }

  return cycles;
}
