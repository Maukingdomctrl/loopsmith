/**
 * LSA v1.0 — typed main-thread proxy for the worker.
 *
 * Owns the postMessage protocol, run-id correlation, AbortSignal wiring and
 * worker lifetime. Nothing above this file should ever see a raw MessageEvent.
 *
 * TRANSFER POLICY: frame buffers are COPIED, not transferred. Transferring
 * would detach the main thread's Uint8ClampedArray views, breaking any re-run
 * and any caller that still holds the DecodedFrame (the hook does, for exactly
 * that reason). At 24 × 128² × 4 B ≈ 1.5 MB the structured-clone copy is
 * sub-millisecond, so the correctness win is free.
 */

import type {
  DecodedFrame,
  LSAResult,
  ProgressEvent,
  StabilizeOptions,
} from "../types";

export type LsaWorkerRequest =
  | {
      readonly type: "run";
      readonly runId: number;
      readonly frames: readonly DecodedFrame[];
      readonly options: StabilizeOptions;
      readonly decodeMs?: number;
    }
  | { readonly type: "cancel"; readonly runId: number };

export type LsaWorkerResponse =
  | {
      readonly type: "progress";
      readonly runId: number;
      readonly progress: ProgressEvent;
    }
  | { readonly type: "result"; readonly runId: number; readonly result: LSAResult }
  | { readonly type: "cancelled"; readonly runId: number }
  | { readonly type: "error"; readonly runId: number; readonly message: string }
  | { readonly type: "unsupported"; readonly runId: number };

export class LsaAbortError extends Error {
  constructor() {
    super("stabilization aborted");
    this.name = "LsaAbortError";
  }
}

export interface RunOptions {
  readonly onProgress?: (e: ProgressEvent) => void;
  readonly signal?: AbortSignal;
  readonly decodeMs?: number;
}

interface PendingRun {
  resolve: (r: LSAResult) => void;
  reject: (e: Error) => void;
  onProgress?: (e: ProgressEvent) => void;
  detach: () => void;
}

function createWorker(): Worker {
  // Next.js / Turbopack / webpack 5 all understand this form and will emit the
  // worker as a separate chunk. Kept in one place so the bundler-specific
  // incantation never leaks into feature code.
  return new Worker(new URL("./lsa.worker.ts", import.meta.url), {
    type: "module",
  });
}

export class LsaWorkerClient {
  private worker: Worker | null = null;
  private nextRunId = 1;
  private pending = new Map<number, PendingRun>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = createWorker();
    worker.onmessage = (event: MessageEvent<LsaWorkerResponse>) =>
      this.handle(event.data);
    worker.onerror = (event) => {
      const message = event.message || "worker crashed";
      for (const [, run] of this.pending) {
        run.detach();
        run.reject(new Error(message));
      }
      this.pending.clear();
      // A crashed worker is unrecoverable; drop it so the next run gets a fresh
      // one rather than inheriting a dead port.
      this.worker?.terminate();
      this.worker = null;
    };

    this.worker = worker;
    return worker;
  }

  private handle(msg: LsaWorkerResponse): void {
    if (msg.type === "progress") {
  console.log(
    `LSA ${msg.progress.stage}: ${msg.progress.completed}/${msg.progress.total}`
  );
} else {
  console.log("LSA", msg.type, msg);
}
    const run = this.pending.get(msg.runId);
    if (!run) return;

    switch (msg.type) {
      case "progress":
        run.onProgress?.(msg.progress);
        return;
      case "result":
        this.pending.delete(msg.runId);
        run.detach();
        run.resolve(msg.result);
        return;
      case "cancelled":
        this.pending.delete(msg.runId);
        run.detach();
        run.reject(new LsaAbortError());
        return;
      case "error":
      case "unsupported":
        this.pending.delete(msg.runId);
        run.detach();
        run.reject(
          new Error(msg.type === "error" ? msg.message : "worker unsupported")
        );
        return;
    }
  }

  run(
    frames: readonly DecodedFrame[],
    options: StabilizeOptions,
    runOptions: RunOptions = {}
  ): Promise<LSAResult> {
    const worker = this.ensureWorker();
    const runId = this.nextRunId++;

    return new Promise<LSAResult>((resolve, reject) => {
      const abort = (): void => {
        worker.postMessage({ type: "cancel", runId } satisfies LsaWorkerRequest);
      };

      const detach = (): void => {
        runOptions.signal?.removeEventListener("abort", abort);
      };

      if (runOptions.signal?.aborted) {
        reject(new LsaAbortError());
        return;
      }
      runOptions.signal?.addEventListener("abort", abort, { once: true });

      this.pending.set(runId, {
        resolve,
        reject,
        onProgress: runOptions.onProgress,
        detach,
      });

      worker.postMessage({
        type: "run",
        runId,
        frames,
        options,
        decodeMs: runOptions.decodeMs,
      } satisfies LsaWorkerRequest);
    });
  }

  /** Release the worker. Safe to call repeatedly; the next run respawns. */
  dispose(): void {
    for (const [, run] of this.pending) {
      run.detach();
      run.reject(new LsaAbortError());
    }
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }
}

/** One-shot convenience for scripts and tests; spawns and disposes a worker. */
export async function runStabilizeInWorker(
  frames: readonly DecodedFrame[],
  options: StabilizeOptions,
  runOptions?: RunOptions
): Promise<LSAResult> {
  const client = new LsaWorkerClient();
  try {
    return await client.run(frames, options, runOptions);
  } finally {
    client.dispose();
  }
}
