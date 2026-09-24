/// <reference lib="webworker" />

/**
 * LSA v1.0 — worker entry.
 *
 * WHY A WORKER AT ALL: at N = 24 with 128×128 cells the integer search alone is
 * ~96 edges × (ROI) × 81 candidates at half resolution, and the IRLS stage adds
 * several resampling sweeps per edge. That is tens to low hundreds of
 * milliseconds — long enough to drop frames, and Loop runs a
 * requestAnimationFrame playback loop that must not stutter. Off-thread keeps
 * the editor interactive and makes cancellation real: the user can keep drawing
 * while it runs, and a stale run can be abandoned when a new import lands.
 *
 * EXACTLY ONE WORKER, deliberately. Parallelizing the edge loop across workers
 * would make the floating-point reduction order depend on thread scheduling and
 * break determinism invariant 3 of §1.3. The engine is fast enough that the
 * trade is not close.
 *
 * The worker owns nothing but marshalling and a cancellation latch: all logic
 * lives in stabilize.ts so it stays testable in Node.
 */

import { stabilize, LsaCancelledError } from "../stabilize";
import { createSignalCache } from "../signal";
import type { LsaWorkerRequest, LsaWorkerResponse } from "./client";

const scope = self as unknown as DedicatedWorkerGlobalScope;

/** Pyramids persist across runs in this worker, keyed by content hash. Re-running
 *  after a pure option change (e.g. toggling the spectral mode) then skips the
 *  signal stage entirely. */
const signalCache = createSignalCache(128);

/** Per-run cancellation latch. `stabilize` polls it between stages and between
 *  edges, so abandonment is bounded by one edge's work (~1 ms). */
let cancelled = false;
let activeRunId: number | null = null;

const post = (msg: LsaWorkerResponse): void => scope.postMessage(msg);

scope.onmessage = (event: MessageEvent<LsaWorkerRequest>): void => {
  const msg = event.data;

  if (msg.type === "cancel") {
    if (activeRunId === null || msg.runId === activeRunId) cancelled = true;
    return;
  }

  if (msg.type !== "run") return;

  activeRunId = msg.runId;
  cancelled = false;

  try {
    const result = stabilize(
      { frames: msg.frames, options: msg.options },
      {
        signalCache,
        decodeMs: msg.decodeMs,
        signal: {
          get aborted() {
            return cancelled;
          },
        },
        onProgress: (progress) =>
          post({ type: "progress", runId: msg.runId, progress }),
      }
    );

    post({ type: "result", runId: msg.runId, result });
  } catch (error) {
    if (error instanceof LsaCancelledError) {
      post({ type: "cancelled", runId: msg.runId });
    } else {
      post({
        type: "error",
        runId: msg.runId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    activeRunId = null;
    cancelled = false;
  }
};
