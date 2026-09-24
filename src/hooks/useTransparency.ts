"use client";

import { useCallback, useMemo, useState } from "react";

export type TransparencyTool = "brush" | "lasso" | "wand";

export interface Point {
  x: number; // normalized 0–1
  y: number; // normalized 0–1
}

export interface TransparencyState {
  enabled: boolean;
  tool: TransparencyTool;

  // mathematically bounded controls
  feather: number;      // 0–5 px
  tolerance: number;    // 0–100

  // normalized geometry
  brushRadius: number;  // 0.001–0.25 (relative to canvas)
  path: Point[];
}

const DEFAULT: TransparencyState = {
  enabled: false,
  tool: "brush",
  feather: 1,
  tolerance: 32,
  brushRadius: 0.025,
  path: [],
};

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

export function useTransparency() {
  const [state, setState] = useState(DEFAULT);
  const [history, setHistory] = useState<TransparencyState[]>([]);
  const [future, setFuture] = useState<TransparencyState[]>([]);

  const commit = useCallback((next: TransparencyState) => {
    setHistory(h => [...h, state]);
    setFuture([]);
    setState(next);
  }, [state]);

  const patch = useCallback((partial: Partial<TransparencyState>) => {
    commit({
      ...state,
      ...partial,
      feather: clamp(partial.feather ?? state.feather, 0, 5),
      tolerance: clamp(partial.tolerance ?? state.tolerance, 0, 100),
      brushRadius: clamp(partial.brushRadius ?? state.brushRadius, 0.001, 0.25),
    });
  }, [state, commit]);

  const beginPath = useCallback((p: Point) => {
    commit({ ...state, path: [p] });
  }, [state, commit]);

  const addPoint = useCallback((p: Point) => {
    setState(prev => ({
      ...prev,
      path: [...prev.path, p],
    }));
  }, []);

  const endPath = useCallback(() => {
    setState(prev => ({ ...prev, path: [] }));
  }, []);

  const undo = useCallback(() => {
    setHistory(h => {
      if (!h.length) return h;
      const previous = h[h.length - 1];
      setFuture(f => [state, ...f]);
      setState(previous);
      return h.slice(0, -1);
    });
  }, [state]);

  const redo = useCallback(() => {
    setFuture(f => {
      if (!f.length) return f;
      const next = f[0];
      setHistory(h => [...h, state]);
      setState(next);
      return f.slice(1);
    });
  }, [state]);

  const reset = useCallback(() => {
    setHistory([]);
    setFuture([]);
    setState(DEFAULT);
  }, []);

  const canUndo = history.length > 0;
  const canRedo = future.length > 0;

  return useMemo(() => ({
    state,
    patch,
    beginPath,
    addPoint,
    endPath,
    undo,
    redo,
    reset,
    canUndo,
    canRedo,
  }), [
    state,
    patch,
    beginPath,
    addPoint,
    endPath,
    undo,
    redo,
    reset,
    canUndo,
    canRedo,
  ]);
}