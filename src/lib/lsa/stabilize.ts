/**
 * LSA v1.0 — the orchestrator.
 *
 * One function with the whole story, readable top to bottom in the section
 * order of §B. Orchestration is separated from computation so the worker
 * wrapper has nothing to do but marshal, and so Node-based tests can drive the
 * pipeline with no DOM.
 *
 * Pure over DecodedFrame[]: decode happens upstream on the main thread (see
 * decode.ts for why), so nothing here touches the platform except the clock,
 * and the clock only feeds `timings`, never a branch (§1.3 invariant 1).
 */

import { DEFAULT_OPTIONS, constantsFingerprint } from "./constants";
import { buildWeightedEdges, computeCurls } from "./curl";
import { buildFrameQuality } from "./diagnostics";
import { buildConstraintGraph } from "./graph";
import { estimatePair } from "./pairwise";
import { buildSignals, type SignalCache } from "./signal";
import { solveTranslations } from "./solver";
import { applySpectralSeparation } from "./spectral";
import type {
  LSAResult,
  PairwiseConstraint,
  ProgressEvent,
  StabilizeOptions,
  StabilizeRequest,
  StageTimings,
} from "./types";

export class LsaCancelledError extends Error {
  constructor() {
    super("stabilization cancelled");
    this.name = "LsaCancelledError";
  }
}

export interface StabilizeHooks {
  readonly onProgress?: (e: ProgressEvent) => void;
  /** Anything with an `aborted` flag: AbortSignal, or the worker's own latch. */
  readonly signal?: { readonly aborted: boolean };
  readonly signalCache?: SignalCache;
  /** Decode time measured by the caller, folded into `timings` for reporting. */
  readonly decodeMs?: number;
}

const now = (): number =>
  typeof performance !== "undefined" ? performance.now() : Date.now();

export function stabilize(
  request: StabilizeRequest,
  hooks: StabilizeHooks = {}
): LSAResult {
  const options: StabilizeOptions = { ...DEFAULT_OPTIONS, ...request.options };
  const frames = request.frames;
  const N = frames.length;

  const tStart = now();
  const check = (): void => {
    if (hooks.signal?.aborted) throw new LsaCancelledError();
  };

  /* ---------------- ② SIGNAL — §B.1–B.2 ---------------- */
  // Premultiply, Gaussian prefilter with zero padding, central differences,
  // pyramid, and the GLOBALLY POOLED per-channel normalization that makes σ̂²
  // comparable across edges (which is what (B.14) needs to be meaningful).
  const tSignal = now();
  hooks.onProgress?.({ stage: "signal", completed: 0, total: N });
  const signals = buildSignals(frames, options.prefilterSigma, hooks.signalCache);
  hooks.onProgress?.({ stage: "signal", completed: N, total: N });
  const signalMs = now() - tSignal;
  check();

  /* ---------------- ③ GRAPH — §B.4.1–B.4.2 ---------------- */
  // Built BEFORE measurement because E is a function of N alone (B.19). That
  // ordering is what lets the pairwise stage be a pure O(|E|) map with a known
  // total for progress reporting.
  const tGraph = now();
  const graph = buildConstraintGraph(
    N,
    signals.map((s) => s.usable),
    options.edgeTopology
  );
  hooks.onProgress?.({ stage: "graph", completed: 1, total: 1 });
  const graphMs = now() - tGraph;
  check();

  /* ---------------- ④ PAIRWISE — §B.2 ---------------- */
  // The only expensive stage. Exhaustive integer search (globally optimal
  // within the jitter prior) then symmetric-stencil Gauss–Newton IRLS.
  const tPairwise = now();
  const constraints: PairwiseConstraint[] = [];
  const edgeTotal = graph.edges.length;
  hooks.onProgress?.({ stage: "pairwise", completed: 0, total: edgeTotal });

  for (let k = 0; k < edgeTotal; k++) {
    check();
    const edge = graph.edges[k];
    constraints.push(
      estimatePair(edge, signals[edge.from], signals[edge.to], {
        searchRadius: options.searchRadius,
        loss: options.robustLoss,
      })
    );
    hooks.onProgress?.({
      stage: "pairwise",
      completed: k + 1,
      total: edgeTotal,
    });
  }
  const pairwiseMs = now() - tPairwise;

  /* ---------------- ⑤ CURL — §B.4.3 ---------------- */
  // z_γᵀd depends on no unknown (A.5), so this is a single pass with no fixed
  // point against the solver. The one discrete decision in the engine, made by
  // a calibrated χ²₂ test rather than a threshold on pixel differences.
  const tCurl = now();
  const curls = computeCurls(graph, constraints);
  const edges = buildWeightedEdges(
    graph,
    constraints,
    curls,
    options.enableCurlRejection
  );
  hooks.onProgress?.({ stage: "curl", completed: 1, total: 1 });
  const curlMs = now() - tCurl;
  check();

  /* ---------------- ⑥ SOLVE — §B.5–B.6 ---------------- */
  const tSolve = now();
  const solution = solveTranslations(graph, edges);
  hooks.onProgress?.({ stage: "solve", completed: 1, total: 1 });
  const solveMs = now() - tSolve;
  check();

  /* ---------------- ⑦ SPECTRAL — §B.7 ---------------- */
  // Constraint 6, in one matrix multiply. With 𝒫 = {0} this reduces to c = −t̂,
  // because the gauge already forces T̂₀ = 0.
  const tSpectral = now();
  const spectral = applySpectralSeparation(solution.offsets, options.spectral);
  hooks.onProgress?.({ stage: "spectral", completed: 1, total: 1 });
  const spectralMs = now() - tSpectral;

  /* ---------------- ⑧ DIAGNOSE — Lemma B.5 ---------------- */
  const quality = buildFrameQuality(graph, constraints, edges, solution);

  const translations = options.quantizeOutput
    ? spectral.corrections.map((c) => ({
        dx: Math.round(c.dx),
        dy: Math.round(c.dy),
        space: c.space,
      }))
    : spectral.corrections;

  const timings: StageTimings = {
    decodeMs: hooks.decodeMs ?? 0,
    signalMs,
    pairwiseMs,
    graphMs,
    curlMs,
    solveMs,
    spectralMs,
    totalMs: now() - tStart + (hooks.decodeMs ?? 0),
  };

  return {
    translations,
    rawOffsets: solution.offsets,
    constraints,
    graph,
    edges,
    curls,
    solution,
    spectral: spectral.decision,
    quality,
    provenance: {
      algorithmVersion: "LSA-1.0",
      inputHashes: frames.map((f) => f.hash),
      frameCount: N,
      cellWidth: frames[0]?.width ?? 0,
      cellHeight: frames[0]?.height ?? 0,
      constantsFingerprint: constantsFingerprint(options),
    },
    timings,
  };
}
