"use client";

/**
 * The React boundary for LSA. The ONLY React-aware file in the feature.
 *
 * It deliberately does NOT write frame state. page.tsx owns history (pushUndo
 * captures activeFrame) and owns the frame reducer; a hook that called
 * setProjects would duplicate the snapshot logic and diverge from it. So this
 * returns an LSAResult and the caller decides how to land it — which is also
 * what lets the same result be re-applied at a different strength without
 * re-solving.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  decodeFrames,
  DEFAULT_OPTIONS,
  LsaWorkerClient,
  type LSAResult,
  type ProgressEvent,
  type StabilizeOptions,
} from "@/lib/lsa";
import { LsaAbortError } from "@/lib/lsa/worker/client";

export type StabilizeStatus = "idle" | "decoding" | "running" | "done" | "error";

export interface StabilizeProgress {
  readonly stage: string;
  readonly fraction: number;
}

export interface UseAutoStabilizeReturn<T extends { image: string | null }> {
  readonly status: StabilizeStatus;
  readonly progress: StabilizeProgress | null;
  readonly result: LSAResult | null;
  readonly error: string | null;
  /** Resolves to the solve, or null if aborted or failed. */
  readonly run: (frames: readonly T[]) => Promise<LSAResult | null>;
  readonly cancel: () => void;
  readonly reset: () => void;
  readonly isBusy: boolean;
}

/**
 * Measured stage weights. Without them the bar stalls at 5% through the stage
 * that consumes 72% of wall time, which users read as a hang.
 */
const STAGE_WEIGHTS: Record<string, number> = {
  signal: 0.15,
  graph: 0.01,
  pairwise: 0.72,
  curl: 0.04,
  solve: 0.05,
  spectral: 0.03,
};

const STAGE_ORDER = ["signal", "graph", "pairwise", "curl", "solve", "spectral"];

function globalFraction(e: ProgressEvent): number {
  let base = 0;
  for (const stage of STAGE_ORDER) {
    if (stage === e.stage) break;
    base += STAGE_WEIGHTS[stage] ?? 0;
  }
  const within = e.total > 0 ? e.completed / e.total : 1;
  return Math.min(1, base + within * (STAGE_WEIGHTS[e.stage] ?? 0));
}

export function useAutoStabilize<T extends { image: string | null }>(
  overrides?: Partial<StabilizeOptions>
): UseAutoStabilizeReturn<T> {
  const [status, setStatus] = useState<StabilizeStatus>("idle");
  const [progress, setProgress] = useState<StabilizeProgress | null>(null);
  const [result, setResult] = useState<LSAResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<LsaWorkerClient | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, []);

  const options = useMemo<StabilizeOptions>(
    () => ({
      ...DEFAULT_OPTIONS,
      ...overrides,
      spectral: { ...DEFAULT_OPTIONS.spectral, ...overrides?.spectral },
    }),
    [overrides]
  );

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    setStatus("idle");
    setProgress(null);
    setResult(null);
    setError(null);
  }, []);

  const run = useCallback(
    async (frames: readonly T[]): Promise<LSAResult | null> => {
      // Supersede any in-flight run: a double click, or a fresh sprite import
      // landing mid-solve, must not race the first run to completion.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setError(null);
      setStatus("decoding");
      setProgress({ stage: "decode", fraction: 0 });

      try {
        const t0 = performance.now();
        const { frames: decoded } = await decodeFrames(
          frames.map((f) => f.image)
        );
        const decodeMs = performance.now() - t0;

        if (controller.signal.aborted) return null;

        setStatus("running");
        setProgress({ stage: "signal", fraction: 0 });

        if (!clientRef.current) clientRef.current = new LsaWorkerClient();

        const solved = await clientRef.current.run(decoded, options, {
          decodeMs,
          signal: controller.signal,
          onProgress: (e) => {
            if (mountedRef.current) {
              setProgress({ stage: e.stage, fraction: globalFraction(e) });
            }
          },
        });

        if (!mountedRef.current || controller.signal.aborted) return null;

        setResult(solved);
        setStatus("done");
        setProgress({ stage: "spectral", fraction: 1 });
        return solved;
      } catch (e) {
        if (e instanceof LsaAbortError) {
          if (mountedRef.current) {
            setStatus("idle");
            setProgress(null);
          }
          return null;
        }
        const message = e instanceof Error ? e.message : String(e);
        if (mountedRef.current) {
          setError(message);
          setStatus("error");
          setProgress(null);
        }
        return null;
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [options]
  );

  return {
    status,
    progress,
    result,
    error,
    run,
    cancel,
    reset,
    isBusy: status === "decoding" || status === "running",
  };
}
