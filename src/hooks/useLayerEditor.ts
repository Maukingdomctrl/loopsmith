"use client";

/**
 * The React boundary for the layer system — deliberately thin.
 *
 * It owns EDITOR state only: selection, tool mode, in-flight gestures, crop
 * draft. It does NOT own the document. Every document mutation is dispatched
 * as a LayerAction and handed to `onCommit`, which `page.tsx` routes through
 * its existing `updateProject`/`pushUndo` pipeline.
 *
 * That split is the same one `useAutoStabilize` already makes, and for the same
 * reason: `page.tsx` captures `activeFrame` inside its undo snapshots, so a
 * hook that wrote projects itself would need a second copy of that logic and
 * would drift from it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Rect, Vec2 } from "@/types/geometry";
import type { Frame } from "@/types/frame";
import type { Layer, LayerSelection } from "@/types/layer";
import { EMPTY_SELECTION } from "@/types/layer";

import {
  isUndoable,
  layerReducer,
  reduceSelectionForFrame,
  type LayerAction,
} from "@/lib/layers/editor";
import {
  beginRotate,
  beginScale,
  type RotateGesture,
  type ScaleGesture,
} from "@/lib/layers/transformOps";
import {
  createCropDraft,
  moveCropDraft,
  resizeCropDraft,
  type DocumentCropDraft,
} from "@/lib/layers/crop";
import {
  primaryLayer,
  pruneSelection,
  selectAdd,
  selectAll,
  selectOnly,
  selectRange,
  selectToggle,
  selectionBounds,
  selectionPivotCanvas,
  transformableLayers,
} from "@/lib/layers/selection";
import {
  layerContentBox,
  layerMatrix,
  screenDeltaToCanvas,
  screenToCanvas,
  type ViewState,
} from "@/lib/layers/layerSpace";
import {
  hitTestHandles,
  hitTestLayerBox,
  pickTopmost,
  type HandleId,
} from "@/lib/geometry/hitTest";
import { findLayer } from "@/lib/layers/layerOps";
import {
  BODY_PICK_TOLERANCE,
  HANDLE_PICK_RADIUS,
  NUDGE_STEP,
  NUDGE_STEP_COARSE,
} from "@/lib/layers/constants";

export type ToolMode = "select" | "transform" | "crop" | "straighten";

/** An in-flight pointer gesture. Discriminated so the move handler cannot
 *  accidentally apply a scale update to a rotation drag. */
type Gesture =
  | { kind: "none" }
  | { kind: "move"; startScreen: Vec2; lastCanvas: Vec2 }
  | { kind: "rotate"; gesture: RotateGesture }
  | { kind: "scale"; gesture: ScaleGesture }
  | { kind: "pivot" }
  | { kind: "straighten"; from: Vec2; to: Vec2 }
  | { kind: "cropMove"; startScreen: Vec2 }
  | { kind: "cropResize"; handle: HandleId };

export interface UseLayerEditorArgs {
  readonly frame: Frame;
  readonly view: ViewState;
  /** Live bounds of the canvas container, for screen→canvas conversion. */
  readonly getBounds: () => DOMRect | null;
  /** Applies a reduced frame to the document; owns undo. */
  readonly onCommit: (next: Frame, opts: { undoable: boolean }) => void;
  /** Opens a new undo step before a gesture's first mutation. */
  readonly onBeginHistory: () => void;
  readonly disabled?: boolean;
  /** Alpha oracle per layer, for pixel-accurate picking. */
  readonly alphaFor?: (layer: Layer) => ((x: number, y: number) => number) | null;
}

export interface UseLayerEditorReturn {
  readonly selection: LayerSelection;
  readonly selectedLayers: readonly Layer[];
  readonly primary: Layer | null;
  readonly selectionBounds: Rect;
  readonly pivotCanvas: Vec2 | null;
  readonly tool: ToolMode;
  readonly setTool: (t: ToolMode) => void;
  readonly cropDraft: DocumentCropDraft | null;
  readonly straightenLine: { from: Vec2; to: Vec2 } | null;
  readonly isDragging: boolean;
  readonly activeHandle: HandleId | null;

  readonly dispatch: (action: LayerAction) => void;
  readonly select: (id: string | null, mode?: "replace" | "toggle" | "add" | "range") => void;
  readonly selectAllLayers: () => void;
  readonly pickAt: (screen: Vec2) => Layer | null;

  readonly onPointerDown: (e: React.PointerEvent) => boolean;
  readonly onPointerMove: (e: React.PointerEvent) => void;
  readonly onPointerUp: (e: React.PointerEvent) => void;

  readonly beginCrop: (rect?: Rect) => void;
  readonly setCropAspect: (aspect: number | null) => void;
  readonly commitCrop: (refit: boolean) => void;
  readonly cancelCrop: () => void;
}

export function useLayerEditor({
  frame,
  view,
  getBounds,
  onCommit,
  onBeginHistory,
  disabled = false,
  alphaFor,
}: UseLayerEditorArgs): UseLayerEditorReturn {
  const [selection, setSelection] = useState<LayerSelection>(EMPTY_SELECTION);
  const [tool, setTool] = useState<ToolMode>("transform");
  const [cropDraft, setCropDraft] = useState<DocumentCropDraft | null>(null);
  const [activeHandle, setActiveHandle] = useState<HandleId | null>(null);

  const gesture = useRef<Gesture>({ kind: "none" });
  const historyOpened = useRef(false);

  /* ---- refs so pointer handlers never re-attach or read stale state ---- */
  const frameRef = useRef(frame);
const selectionRef = useRef(selection);
const viewRef = useRef(view);
const syncKeyRef = useRef("");

useEffect(() => {
  frameRef.current = frame;
}, [frame]);

useEffect(() => {
  selectionRef.current = selection;
}, [selection]);

useEffect(() => {
  viewRef.current = view;
}, [view]);

const layerIds = useMemo(
  () => frame.layers.map((l) => l.id).join("|"),
  [frame.layers]
);

useEffect(() => {
  const key = `${frame.id}:${frame.activeLayerId}:${layerIds}`;
  if (syncKeyRef.current === key) return;
  syncKeyRef.current = key;

  setSelection((prev) => {
    const next = reduceSelectionForFrame(frame, prev);
    if (next === prev) return prev;                          // ← ref equality fast path

    const same =
      prev.primary === next.primary &&
      prev.ids.length === next.ids.length &&
      (prev.ids.length === 0 ||                             // ← guard empty arrays
        prev.ids.every((id, i) => id === next.ids[i]));

    return same ? prev : next;
  });
}, [frame.id, frame.activeLayerId, layerIds]);




const dispatch = useCallback(
    (action: LayerAction) => {
      if (disabled) return;
      const current = frameRef.current;
      const next = layerReducer(current, action);
      if (next === current) return; // reducer reported a no-op

      const undoable = isUndoable(action);
      // A gesture opens exactly ONE undo step, on its first mutation.
      if (undoable && !historyOpened.current) {
        onBeginHistory();
        historyOpened.current = true;
      }
      onCommit(next, { undoable });
      frameRef.current = next;
    },
    [disabled, onBeginHistory, onCommit]
  );

  /* ---------------- selection ---------------- */

  const select = useCallback(
    (id: string | null, mode: "replace" | "toggle" | "add" | "range" = "replace") => {
      const layers = frameRef.current.layers;
      setSelection((prev) => {
        if (!id) return EMPTY_SELECTION;
        switch (mode) {
          case "toggle": return selectToggle(prev, id);
          case "add":    return selectAdd(prev, id);
          case "range":  return selectRange(layers, prev, id);
          default:       return selectOnly(id);
        }
      });
      if (id) dispatch({ type: "layer/setActive", id });
    },
    [dispatch]
  );

  const selectAllLayers = useCallback(() => {
    setSelection(selectAll(frameRef.current.layers));
  }, []);

  /* ---------------- picking ---------------- */

  /**
   * Topmost layer under a screen point.
   *
   * Descends the stack because the compositor ascends it — the two orders must
   * be exact mirrors, or clicking selects something other than what is drawn
   * on top. Alpha-aware when a sampler is available, so clicking a transparent
   * corner of a rotated sprite falls through to the layer beneath.
   */
  const pickAt = useCallback(
    (screen: Vec2): Layer | null => {
      const f = frameRef.current;
      const p = screenToCanvas(screen, getBounds(), viewRef.current);
      return pickTopmost(f.layers, (layer) => {
        if (!layer.visible || !(layer.image || layer.strokes?.length)) return false;
        const alphaAt = alphaFor?.(layer) ?? undefined;
        return (
          hitTestLayerBox(layerMatrix(layer), layerContentBox(layer), p, {
            tolerance: BODY_PICK_TOLERANCE,
            alphaAt,
            alphaThreshold: 0,
          }) !== null
        );
      });
    },
    [alphaFor, getBounds]
  );

  /* ---------------- pointer ---------------- */

  /**
   * Returns TRUE when the gesture was consumed.
   *
   * Canvas uses that to decide whether to fall through to its own legacy
   * pan/lasso handling, so the layer tools compose with the existing
   * interactions instead of replacing them.
   */
  const onPointerDown = useCallback(
    (e: React.PointerEvent): boolean => {
      if (disabled || e.button !== 0) return false;
      const bounds = getBounds();
      const screen: Vec2 = { x: e.clientX, y: e.clientY };
      const canvas = screenToCanvas(screen, bounds, viewRef.current);
      historyOpened.current = false;

      /* ---- crop tool ---- */
      if (tool === "crop" && cropDraft) {
        const handle = cropHandleAt(cropDraft.rect, canvas);
        if (handle) {
          gesture.current = { kind: "cropResize", handle };
          setActiveHandle(handle);
        } else {
          gesture.current = { kind: "cropMove", startScreen: screen };
        }
        (e.target as Element).setPointerCapture?.(e.pointerId);
        return true;
      }

      /* ---- straighten tool: drag a reference line ---- */
      if (tool === "straighten") {
        gesture.current = { kind: "straighten", from: canvas, to: canvas };
        (e.target as Element).setPointerCapture?.(e.pointerId);
        return true;
      }

      const sel = selectionRef.current;
      const primary = primaryLayer(frameRef.current.layers, sel);

      /* ---- handles of the current selection take priority over picking ---- */
      if (tool === "transform" && primary && !primary.locked) {
        const hit = hitTestHandles(
          layerMatrix(primary),
          layerContentBox(primary),
          primary.pose.pivot,
          canvas,
          HANDLE_PICK_RADIUS
        );
        if (hit && hit.id === "pivot") {
          gesture.current = { kind: "pivot" };
          setActiveHandle("pivot");
          (e.target as Element).setPointerCapture?.(e.pointerId);
          return true;
        }
        if (hit && hit.id === "rotate") {
          const g = beginRotate(frameRef.current.layers, sel, canvas);
          if (g) {
            gesture.current = { kind: "rotate", gesture: g };
            setActiveHandle("rotate");
            (e.target as Element).setPointerCapture?.(e.pointerId);
            return true;
          }
        }
        if (hit && hit.id !== "body") {
          const g = beginScale(frameRef.current.layers, sel, hit.id, canvas);
          if (g) {
            gesture.current = { kind: "scale", gesture: g };
            setActiveHandle(hit.id);
            (e.target as Element).setPointerCapture?.(e.pointerId);
            return true;
          }
        }
      }

      /* ---- pick, then move ---- */
      const picked = pickAt(screen);
      if (!picked) {
        // Empty space clears the selection but does NOT consume the event, so
        // Canvas's existing pan behaviour still works.
        if (sel.ids.length) setSelection(EMPTY_SELECTION);
        return false;
      }

      const mode = e.shiftKey ? "range" : e.metaKey || e.ctrlKey ? "toggle" : "replace";
      const alreadySelected = sel.ids.includes(picked.id);
      if (!alreadySelected || mode !== "replace") select(picked.id, mode);

      if (picked.locked) return true; // selectable, not movable

      gesture.current = { kind: "move", startScreen: screen, lastCanvas: canvas };
      setActiveHandle("body");
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return true;
    },
    [cropDraft, disabled, getBounds, pickAt, select, tool]
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const g = gesture.current;
      if (g.kind === "none" || disabled) return;

      const bounds = getBounds();
      const screen: Vec2 = { x: e.clientX, y: e.clientY };
      const canvas = screenToCanvas(screen, bounds, viewRef.current);
      const sel = selectionRef.current;

      switch (g.kind) {
        case "move": {
          // Incremental delta against the LAST canvas point, so the layer
          // tracks the cursor exactly even if a frame is dropped.
          const delta = { x: canvas.x - g.lastCanvas.x, y: canvas.y - g.lastCanvas.y };
          gesture.current = { ...g, lastCanvas: canvas };
          if (delta.x || delta.y) dispatch({ type: "xf/move", selection: sel, delta });
          break;
        }
        case "rotate":
          dispatch({
            type: "xf/rotateDrag",
            selection: sel,
            gesture: g.gesture,
            pointer: canvas,
            snap: e.shiftKey,
          });
          break;
        case "scale":
          dispatch({
            type: "xf/scaleDrag",
            gesture: g.gesture,
            pointer: canvas,
            // Shift = uniform, Alt = from centre: the conventions every other
            // editor uses, so muscle memory transfers.
            uniform: e.shiftKey,
            fromCenter: e.altKey,
          });
          break;
        case "pivot":
          if (sel.primary) {
            dispatch({ type: "xf/pivotCanvas", id: sel.primary, point: canvas });
          }
          break;
        case "straighten":
          gesture.current = { ...g, to: canvas };
          // Force a repaint of the guide line without touching the document.
          setActiveHandle((h) => h);
          setStraightenTick((t) => t + 1);
          break;
        case "cropMove": {
          if (!cropDraft) break;
          const delta = screenDeltaToCanvas(
            { x: screen.x - g.startScreen.x, y: screen.y - g.startScreen.y },
            bounds,
            viewRef.current
          );
          gesture.current = { ...g, startScreen: screen };
          setCropDraft((d) => (d ? moveCropDraft(d, delta) : d));
          break;
        }
        case "cropResize":
          setCropDraft((d) => (d ? resizeCropDraft(d, g.handle, canvas) : d));
          break;
      }
    },
    [cropDraft, disabled, dispatch, getBounds]
  );

  // Straighten's preview line is local state; a counter forces the re-render
  // without pushing anything into the document.
  const [straightenTick, setStraightenTick] = useState(0);
  const straightenLine = useMemo(() => {
    const g = gesture.current;
    return g.kind === "straighten" ? { from: g.from, to: g.to } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [straightenTick]);

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const g = gesture.current;
      gesture.current = { kind: "none" };
      setActiveHandle(null);
      historyOpened.current = false;

      if ((e.target as Element).hasPointerCapture?.(e.pointerId)) {
        (e.target as Element).releasePointerCapture(e.pointerId);
      }

      // Straighten commits on RELEASE, once, from the completed line — a
      // per-move commit would stack dozens of rotations into the undo stack
      // and fight the user's own drag.
      if (g.kind === "straighten") {
        onBeginHistory();
        historyOpened.current = true;
        dispatch({
          type: "xf/straighten",
          selection: selectionRef.current,
          a: g.from,
          b: g.to,
          axis: "horizontal",
        });
        historyOpened.current = false;
        setTool("transform");
      }
    },
    [dispatch, onBeginHistory]
  );

  /* ---------------- crop ---------------- */

  const beginCrop = useCallback((r?: Rect) => {
    setCropDraft(createCropDraft(r));
    setTool("crop");
  }, []);

  const setCropAspect = useCallback((aspect: number | null) => {
    setCropDraft((d) => (d ? { ...d, aspect } : d));
  }, []);

  const commitCrop = useCallback(
    (refit: boolean) => {
      const draft = cropDraft;
      if (!draft) return;
      onBeginHistory();
      historyOpened.current = true;
      dispatch({ type: "crop/commitDocument", draft, refit });
      historyOpened.current = false;
      setCropDraft(null);
      setTool("transform");
    },
    [cropDraft, dispatch, onBeginHistory]
  );

  const cancelCrop = useCallback(() => {
    // Nothing was mutated: the draft is pure editor state.
    setCropDraft(null);
    setTool("transform");
  }, []);

  /* ---------------- keyboard ---------------- */

  useEffect(() => {
    if (disabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;

      const sel = selectionRef.current;
      const step = e.shiftKey ? NUDGE_STEP_COARSE : NUDGE_STEP;

      const nudge = (dx: number, dy: number) => {
        if (!sel.ids.length) return;
        e.preventDefault();
        onBeginHistory();
        historyOpened.current = true;
        dispatch({ type: "xf/nudge", selection: sel, dx, dy });
        historyOpened.current = false;
      };

      // Alt+arrows nudge layers; bare arrows stay bound to frame navigation,
      // so the existing timeline shortcuts are untouched.
      if (e.altKey && e.key === "ArrowLeft")  return nudge(-step, 0);
      if (e.altKey && e.key === "ArrowRight") return nudge(step, 0);
      if (e.altKey && e.key === "ArrowUp")    return nudge(0, -step);
      if (e.altKey && e.key === "ArrowDown")  return nudge(0, step);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAllLayers();
        return;
      }
      if (e.key === "Escape" && cropDraft) { e.preventDefault(); cancelCrop(); return; }
      if (e.key === "Enter" && cropDraft)  { e.preventDefault(); commitCrop(true); return; }

      if ((e.key === "Delete" || e.key === "Backspace") && sel.primary) {
        const layer = findLayer(frameRef.current.layers, sel.primary);
        // The base layer is permanent; Delete on it is a no-op by contract.
        if (layer && layer.kind !== "base" && !layer.locked) {
          e.preventDefault();
          onBeginHistory();
          historyOpened.current = true;
          dispatch({ type: "layer/remove", id: sel.primary });
          historyOpened.current = false;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelCrop, commitCrop, cropDraft, disabled, dispatch, onBeginHistory, selectAllLayers]);

  /* ---------------- derived ---------------- */

  const selected = useMemo(
    () => transformableLayers(frame.layers, selection),
    [frame.layers, selection]
  );
  const primary = useMemo(
    () => primaryLayer(frame.layers, selection),
    [frame.layers, selection]
  );
  const bounds = useMemo(
    () => selectionBounds(frame.layers, selection),
    [frame.layers, selection]
  );
  const pivot = useMemo(
    () => selectionPivotCanvas(frame.layers, selection),
    [frame.layers, selection]
  );

  return {
    selection,
    selectedLayers: selected,
    primary,
    selectionBounds: bounds,
    pivotCanvas: pivot,
    tool,
    setTool,
    cropDraft,
    straightenLine,
    isDragging: gesture.current.kind !== "none",
    activeHandle,
    dispatch,
    select,
    selectAllLayers,
    pickAt,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    beginCrop,
    setCropAspect,
    commitCrop,
    cancelCrop,
  };
}

/** Which crop handle, if any, is under a canvas point. */
function cropHandleAt(r: Rect, p: Vec2): HandleId | null {
  const R = HANDLE_PICK_RADIUS;
  const xs: [number, number][] = [[r.x, 0], [r.x + r.w / 2, 0.5], [r.x + r.w, 1]];
  const ys: [number, number][] = [[r.y, 0], [r.y + r.h / 2, 0.5], [r.y + r.h, 1]];
  const name: Record<string, HandleId> = {
    "0,0": "nw", "0.5,0": "n", "1,0": "ne",
    "0,0.5": "w", "1,0.5": "e",
    "0,1": "sw", "0.5,1": "s", "1,1": "se",
  };
  for (const [px, ax] of xs) {
    for (const [py, ay] of ys) {
      if (ax === 0.5 && ay === 0.5) continue;
      if (Math.hypot(px - p.x, py - p.y) <= R) return name[`${ax},${ay}`] ?? null;
    }
  }
  return null;
}
