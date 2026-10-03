"use client";

import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useCallback,
  useMemo,
  type RefObject,
} from "react";
import {
  PenTool,
  Check,
  Undo2,
  X,
  Crosshair,
} from "lucide-react";

import EmojiGuides from "./EmojiGuides";
import TransformOverlay from "./TransformOverlay";
import CropOverlay from "./CropOverlay";
import { drawFrameLayers } from "@/lib/drawFrame";
import {
  CANVAS_SIZE,
  fitScale,
  isBakeable,
  isFlatDocument,
  clearTransforms,
  baseLayerMatrix,
} from "@/lib/frameTransform";
import { MAT_IDENTITY, matApply, matChain, matInvert, matScale } from "@/lib/geometry/mat2d";
import { RasterSurface, type SurfaceSnapshot } from "@/lib/raster/surface";
import { MaterialStroke } from "@/lib/raster/brushes/materialStroke";
import { brushSpec, defaultBrushPrefs, formatSize, sizeStep } from "@/lib/raster/brushes/presets";
import type { BrushId, BrushPrefs } from "@/lib/raster/brushes/types";
import { floodFill } from "@/lib/raster/floodFill";
import { drawShape, geometryFromDrag } from "@/lib/raster/shapes";
import { DEFAULT_ARROW_HEAD_LENGTH, DEFAULT_ARROW_HEAD_WIDTH, normalizePressure } from "@/lib/raster/constants";
import { rectNormalize } from "@/lib/geometry/rect";
import { parseHex, toHex } from "@/lib/raster/color";
import {
  PENCIL_MAX_SIZE,
  PENCIL_MIN_SIZE,
  createStrokeId,
  seedFromString,
  type PencilStroke,
} from "@/lib/pencil/types";
import { renderStrokes, widthFactor } from "@/lib/pencil/render";
import { bakeLayerStrokes } from "@/lib/pencil/bake";
import { markLiveStroke, onStrokeRefine, type BitmapResolver } from "@/lib/layers/composite";
import type { FloodFillSettings, RGBA, ShapeKind } from "@/types/raster";
import type { Frame } from "@/types/frame";
import type { Mat2D, Rect } from "@/types/geometry";
import type { CanvasBackground, Layer, LayerSelection } from "@/types/layer";
import { DEFAULT_BACKGROUND, isLockedIn } from "@/types/layer";
import type { UseLayerEditorReturn } from "@/hooks/useLayerEditor";
import {
  domResolver,
  loadBitmap,
  preloadFrameBitmaps,
} from "@/lib/layers/flatten";
import { baseLayer, findLayer } from "@/lib/layers/layerOps";
import { defaultFitPose, layerMatrix, screenToCanvas } from "@/lib/layers/layerSpace";
import { makePose } from "@/lib/geometry/pose";
import type { TransparencyState } from "@/hooks/useTransparency";
import BrushCursor from "./BrushCursor";
import BrushPanel from "./BrushPanel";
import ToolRail from "./ToolRail";
import { DEFAULT_PAINT, onion, overlay, rangeFill } from "@/styles/tokens";

export type CanvasView = {
  x: number;
  y: number;
  rotation: number;
};

interface CanvasProps {
  projectId: string;

  /**
   * The 512×512 container element, owned by page.tsx.
   *
   * `useLayerEditor` needs live DOMRect bounds to convert screen coordinates
   * into canvas space, and the hook must live in page.tsx because page.tsx
   * owns the undo pipeline. Hoisting the ref is the smallest change that lets
   * both hold true; Canvas simply attaches it.
   */
  containerRef: RefObject<HTMLDivElement | null>;

  /** Canvas transparency + backdrop. DOCUMENT state, so it is also exported. */
  background: CanvasBackground;

  transparency: TransparencyState;

  /** Selection, tool mode, gestures and dispatch. */
  editor: UseLayerEditorReturn;

  /** The frame being displayed. Read-only — during playback this is not the edit frame. */
  frame: Frame;
  /** The only frame Canvas is ever allowed to mutate. */
  editFrame: Frame;
  isPlaying: boolean;

  /** Neighbours to onion-skin: offset < 0 is before the current frame, > 0 after. */
  onionFrames: { frame: Frame; offset: number }[];
  onionSkin: boolean;

  view: CanvasView;
  onViewChange: (
    view: CanvasView | ((prev: CanvasView) => CanvasView)
  ) => void;

  onImport?: () => void;
  onImageDrop?: (file: File) => void;
  onChange: (frame: Frame) => void;

  onHistoryCommit?: () => void;
  onHistoryPushFrame?: (frame: Frame) => void;
  onSaveStatusChange?: (status: "saving" | "saved") => void;
  onSelectionActiveChange?: (active: boolean) => void;
  /** Paint tools draw on the selected layer's mask instead of its pixels. */
  editMask?: boolean;
  showGuides: boolean;
  guideMode: "face" | "fullbody";
  /** On-screen size of the canvas card, in px. Drawing stays 512 internally. */
  stageSize?: number;
  /* Tool rail: these controls live on the canvas but the state is page.tsx's. */
  onBackgroundChange?: (next: CanvasBackground) => void;
  onOnionSkinChange?: (on: boolean) => void;
  onGuidesChange?: (show: boolean, mode: "face" | "fullbody") => void;
  onDuplicateFrame?: () => void;
  onClearFrame?: () => void;
  onDeleteFrame?: () => void;
  /** Shown in the pill above the canvas. */
  frameInfo?: { index: number; count: number; seconds: number; fps: number };
}

const ZOOM_MIN = 0.25;
/** The stage canvases render at the screen's own pixel density, up to this
 *  many backing pixels per canvas px (a 1536² ceiling keeps playback cheap). */
const MAX_STAGE_DENSITY = 3;
const ZOOM_MAX = 8;
const SAVE_DEBOUNCE_MS = 500;
/** Size of a fresh drawing sheet on an empty frame. */
const BLANK_SIZE = 512;
/** Pressure used for a mouse, which reports none. */
const MOUSE_PRESSURE = 0.62;

/**
 * Whether this pointer reports real pressure. A pen always does. Many styluses
 * (Android tablets, some Windows pens) arrive as "touch" but still send real
 * pressure; a finger or a device without pressure sends 0, 0.5 or 1.
 */
function reportsPressure(e: Pick<PointerEvent, "pointerType" | "pressure">): boolean {
  if (e.pointerType === "pen") return true;
  return (
    e.pointerType === "touch" && e.pressure > 0 && e.pressure < 1 && e.pressure !== 0.5
  );
}

/** Layer pixels → stage pixels: the matrix the compositor draws the layer with. */
function stageMatrix(layer: Layer, size: number): Mat2D {
  const k = size / CANVAS_SIZE;
  return matChain(matScale(k, k), layerMatrix(layer));
}

/** Stage pixels per layer pixel. */
const stageDensity = (m: Mat2D) => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));

/**
 * The stage pixels a rect of a layer's pixels can change, at stage size
 * `size`: the rect mapped through the matrix the compositor draws the layer
 * with, widened by the reach of its resampling filter (about a layer pixel
 * when the layer is enlarged, more when it is shrunk) and rounded out.
 */
function stageArea(layer: Layer, r: Rect, size: number): Rect | null {
  const m = stageMatrix(layer, size);
  const pad = 2 + Math.ceil(2 / Math.max(stageDensity(m), 1e-3));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of [
    [r.x - pad, r.y - pad], [r.x + r.w + pad, r.y - pad],
    [r.x - pad, r.y + r.h + pad], [r.x + r.w + pad, r.y + r.h + pad],
  ]) {
    const q = matApply(m, { x, y });
    x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y);
    x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
  }
  const ax = Math.max(0, Math.floor(x0) - 2), ay = Math.max(0, Math.floor(y0) - 2);
  const bx = Math.min(size, Math.ceil(x1) + 2), by = Math.min(size, Math.ceil(y1) + 2);
  return bx > ax && by > ay ? { x: ax, y: ay, w: bx - ax, h: by - ay } : null;
}

/** Size slider: continuous and logarithmic, so small sizes get most of the
 *  travel. 0…1000 ↔ PENCIL_MIN_SIZE…PENCIL_MAX_SIZE. */
const SIZE_SPAN = Math.log(PENCIL_MAX_SIZE / PENCIL_MIN_SIZE);
const sizeToSlider = (s: number) => (1000 * Math.log(s / PENCIL_MIN_SIZE)) / SIZE_SPAN;
const sliderToSize = (v: number) => PENCIL_MIN_SIZE * Math.exp((v / 1000) * SIZE_SPAN);

const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/**
 * Onion skin must never paint a backdrop.
 *
 * The onion canvas sits ON TOP of the base canvas, so honouring an opaque
 * document background here would paint a solid rectangle over the artwork the
 * animator is drawing. The document's own background is drawn once, by the
 * base composite.
 */
const ONION_BACKGROUND: CanvasBackground = {
  transparent: true,
  color: "#000000",
  checkerboard: false,
};

/** Onion tints, as in Animate: frames before are red-ish, frames after green-ish. View only. */
const ONION_BEFORE = onion.before;
const ONION_AFTER = onion.after;

export default function Canvas({
  projectId,
  containerRef,
  background,
  transparency,
  editor,
  frame,
  editFrame,
  isPlaying,
  onionFrames,
  onionSkin,
  view,
  onViewChange,
  onImport,
  onImageDrop,
  onChange,
  onHistoryCommit,
  onHistoryPushFrame,
  onSaveStatusChange,
  onSelectionActiveChange,
  editMask = false,
  showGuides,
  guideMode,
  stageSize = CANVAS_SIZE,
  onBackgroundChange,
  onOnionSkinChange,
  onGuidesChange,
  onDuplicateFrame,
  onClearFrame,
  onDeleteFrame,
  frameInfo,
}: CanvasProps) {
  const baseCanvasRef = useRef<HTMLCanvasElement>(null);
  const onionCanvasRef = useRef<HTMLCanvasElement>(null);
  /** Scratch surface where each onion frame is drawn and tinted. */
  const onionScratch = useRef<HTMLCanvasElement | null>(null);
  const selectionCanvasRef = useRef<HTMLCanvasElement>(null);

  /** Local alias so existing coordinate helpers keep reading naturally. */
  const canvasContainerRef = containerRef;

  const [lassoMode, setLassoMode] = useState(false);
  const [alignMode, setAlignMode] = useState(false);
  const [points, setPoints] = useState<{ x: number; y: number }[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const [selectionActive, setSelectionActive] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [brushPos, setBrushPos] = useState<{ x: number; y: number } | null>(null);

  const [selectionCanvas, setSelectionCanvas] =
    useState<HTMLCanvasElement | null>(null);
  const [selectionOffset, setSelectionOffset] = useState({ x: 0, y: 0 });
  const [selectionSize, setSelectionSize] = useState({ w: 0, h: 0 });

  const selectionStart = useRef({ x: 0, y: 0 });

  /** Offscreen snapshot of the base frame containing the cut hole. */
  const baseHoleCanvas = useRef<HTMLCanvasElement | null>(null);

  /** Image the selection flow itself last committed (the hole). */
  const selectionFlowImage = useRef<string | null>(null);

  /** Frame state from before the destructive cut — the single undo step for a move. */
  const preCutFrame = useRef<Frame | null>(null);

  const frameId = editFrame.id;

  /**
   * Bumped whenever a bitmap finishes decoding.
   *
   * The compositor is SYNCHRONOUS and silently skips layers whose bitmaps are
   * not yet in the shared cache — that is what keeps it usable inside a single
   * animation frame and inside the export loop with no await points. The cost
   * is that Canvas must repaint once decoding lands, and this counter is the
   * trigger.
   */
  const [decodeGeneration, setDecodeGeneration] = useState(0);

  /* ---------- Stable refs so listeners don't re-attach every render ---------- */

  const editRef = useRef(editFrame);

  // Keep the local ref synchronized after Undo/Redo
  useEffect(() => {
    editRef.current = editFrame;
  }, [editFrame]);

  const onChangeRef = useRef(onChange);
useEffect(() => {
  onChangeRef.current = onChange;
}, [onChange]);

/** Every mutation is built from the edit frame, never from the displayed frame. */
const commit = useCallback((next: Frame) => {
  editRef.current = next;
  onChangeRef.current(next);
}, []);


  /* ---------- Layer targets ---------- */

  /** The permanent base layer. Always present; see types/layer.ts. */
  const base = useMemo(() => baseLayer(editFrame.layers), [editFrame.layers]);

  /** The layer the paint tools draw on: the selected layer, else the base. */
  const paintLayer = useMemo(
    () => findLayer(editFrame.layers, editor.primary?.id ?? null) ?? base,
    [editFrame.layers, editor.primary?.id, base]
  );
  const paintIdRef = useRef<string | null>(null);
  paintIdRef.current = paintLayer?.id ?? null;
  /** Painting the layer's mask (greys) rather than its pixels. */
  const maskMode = editMask && !!paintLayer?.mask;
  /** What `surfaceRef` must hold pixels of for this target. */
  const surfaceKey = paintLayer ? (maskMode ? `${paintLayer.id}#mask` : paintLayer.id) : null;
  /** The image the working surface is made from. */
  const surfaceImage = paintLayer ? (maskMode ? paintLayer.mask?.image ?? null : paintLayer.image) : null;

  /** The paint colour; on a mask, its grey (inverted masks store the opposite,
   *  so white still reveals). `hide` = the colour that hides (the eraser). */
  const paintRGBA = (hide = false): RGBA => {
    const c = parseHex(paintColor) ?? { r: 0, g: 0, b: 0, a: 1 };
    if (!maskMode) return c;
    let v = hide ? 0 : 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    if (paintLayer?.mask?.inverted) v = 1 - v;
    return { r: v, g: v, b: v, a: 1 };
  };

  /** Canvas → layer matrix of the painted layer. The base keeps its
   *  stabilization offset (baseLayerMatrix); other layers use their pose. */
  const paintMatrix = useCallback((f: Frame) => {
    const l = findLayer(f.layers, paintIdRef.current);
    if (!l) return null;
    return l.kind === "base" ? baseLayerMatrix(f) : layerMatrix(l);
  }, []);

  /**
   * What the legacy zoom / reset / nudge controls act on.
   *
   * The primary selection when there is one, the base layer otherwise. For a
   * single-layer project the two are the same, so the controls behave exactly
   * as they did before layers existed.
   */
  const targetLayer: Layer | null =
    // Adjustments and groups have no size of their own.
    editor.primary && !editor.primary.adjust && editor.primary.kind !== "group" ? editor.primary : base;

  /** Selection consisting solely of the base layer — the legacy drag target. */
  const baseSelection = useMemo<LayerSelection>(
    () => (base ? { primary: base.id, ids: [base.id] } : { primary: null, ids: [] }),
    [base]
  );

  /**
   * `zoom` in the legacy sense: scale relative to the layer's own contain-fit.
   *
   * Derived rather than stored, so the number in the field means exactly what
   * it always meant — and cannot drift from the pose that actually renders.
   */
  const targetBaseScale = useMemo(
    () =>
      targetLayer && targetLayer.size.w > 0
        ? fitScale(targetLayer.size.w, targetLayer.size.h, CANVAS_SIZE)
        : 1,
    [targetLayer]
  );

  const targetZoom = targetLayer
    ? Math.abs(targetLayer.pose.scale.x) / targetBaseScale
    : 1;

  /** Any layer with pixels. Replaces the old `frame.image` emptiness test. */
  const hasPixels = useMemo(
    () => frame.layers.some((l) => l.image || l.strokes?.length),
    [frame.layers]
  );

  /* ================================================================ */
  /*  Paint tools                                                       */
  /*                                                                   */
  /*  Pencil and eraser record STROKE PHYSICS on the selected layer            */
  /*  (lib/pencil); the compositor renders them analytically at every   */
  /*  resolution. Fill works on pixels (lib/raster) and folds strokes   */
  /*  into the bitmap first. One stroke = one undo step.                */
  /* ================================================================ */

  type PaintTool = "none" | "pencil" | "brush" | "eraser" | "fill" | "picker" | "shape";
  const [paintTool, setPaintTool] = useState<PaintTool>("none");
  const [paintColor, setPaintColor] = useState(DEFAULT_PAINT);
  /** Pencil / eraser tip radius at full pressure, in CANVAS px (continuous). */
  const [brushSize, setBrushSize] = useState(1.5);
  /** Live pen pressure, so the cursor tip shows the width being drawn. */
  const [tipPressure, setTipPressure] = useState(MOUSE_PRESSURE);
  /** Which of the five brushes the Brush tool paints with, and each one's own settings. */
  const [brushId, setBrushId] = useState<BrushId>("softRound");
  const [brushPrefs, setBrushPrefs] = useState<Record<BrushId, BrushPrefs>>(() =>
    defaultBrushPrefs()
  );
  const [brushPanelOpen, setBrushPanelOpen] = useState(false);
  const brushPanelRef = useRef<HTMLDivElement>(null);
  const paintToolsRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  /** Room the canvas card has, so it shrinks instead of overflowing. */
  const [stageRoom, setStageRoom] = useState(Infinity);
  useEffect(() => {
    const sec = sectionRef.current;
    if (!sec) return;
    // Sides: a little air. Top and bottom: room for the controls above the card.
    const MARGIN_X = 24;
    const MARGIN_Y = 72;
    const ro = new ResizeObserver(() => {
      const cs = getComputedStyle(sec);
      const w = sec.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      setStageRoom(Math.min(w - 2 * MARGIN_X, sec.clientHeight - 2 * MARGIN_Y));
    });
    ro.observe(sec);
    return () => ro.disconnect();
  }, []);
  const stagePx = Math.max(240, Math.min(stageSize, stageRoom));

  // Screen pixels per CSS px. It changes with browser zoom and when the window
  // moves to another display; each change re-arms a query for the new value.
  const [dpr, setDpr] = useState(1);
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    const update = () => {
      setDpr(window.devicePixelRatio || 1);
      mq?.removeEventListener("change", update);
      mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      mq.addEventListener("change", update);
    };
    update();
    return () => mq?.removeEventListener("change", update);
  }, []);
  /**
   * Backing size of the stage canvases, in device pixels. The document is laid
   * out in CANVAS_SIZE units; rendering it at the size it is actually shown
   * (stage scale × device pixel ratio) means nothing is stretched after the
   * fact: pencil strokes and edges are drawn at screen resolution, and layer
   * bitmaps are resampled once, straight to the screen's pixels.
   */
  const stageRes = Math.round(
    CANVAS_SIZE * Math.min(MAX_STAGE_DENSITY, Math.max(1, (stagePx / CANVAS_SIZE) * dpr))
  );
  /** Shapes: which one, solid or outline, and the outline width in canvas px. */
  const [shapeKind, setShapeKind] = useState<ShapeKind>("rectangle");
  const [shapeFill, setShapeFill] = useState(false);
  const [shapeWidth, setShapeWidth] = useState(4);
  /** The shape being dragged: the surface as it was, so each move redraws from clean. */
  const shapeRef = useRef<{ start: { x: number; y: number }; snap: SurfaceSnapshot; drew: boolean } | null>(null);
  /** Where the brush panel sits, in the workspace's own coordinates. */
  const [brushPanelPos, setBrushPanelPos] = useState({ left: 12, top: 12 });

  /** The panel's "Eraser brush" switch still works: it maps to the eraser tool. */
  const activeTool: PaintTool =
    paintTool !== "none"
      ? paintTool
      : transparency.enabled && transparency.tool === "brush"
        ? "eraser"
        : "none";

  const brushNow = brushPrefs[brushId];
  const brushSpecNow = brushSpec(brushId);
  const brushPanelVisible = brushPanelOpen && activeTool === "brush";
  /** The radius the cursor and the size bar show: the brush's own, or the eraser's. */
  const brushPanelVisibleRef = useRef(false);
  useEffect(() => {
    brushPanelVisibleRef.current = brushPanelVisible;
  }, [brushPanelVisible]);

  /** The size bar (pencil, eraser, brush with its panel shut; line width for
   *  shapes) is a pop-out like the rail's flyouts: it opens when a tool is
   *  picked and closes on a click elsewhere, so it never sits over the work. */
  const [sizeBarOpen, setSizeBarOpen] = useState(false);
  const sizeBarRef = useRef<HTMLDivElement>(null);
  const sizeBarOpenRef = useRef(false);
  useEffect(() => {
    sizeBarOpenRef.current = sizeBarOpen;
  }, [sizeBarOpen]);
  useEffect(() => {
    if (!sizeBarOpen) return;
    // Capture phase and never stopped: a press on the canvas both closes the
    // bar and starts the stroke. The rail is left alone so its buttons work.
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (sizeBarRef.current?.contains(t) || paintToolsRef.current?.contains(t))) return;
      setSizeBarOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [sizeBarOpen]);

  const surfaceRef = useRef<RasterSurface | null>(null);
  const surfaceSrc = useRef<string | null>(null);
  /** The pencil / eraser stroke being drawn: its samples grow in place until pen-up. */
  const liveRef = useRef<{ stroke: PencilStroke & { pts: number[] }; t0: number } | null>(null);
  /** The material brush stroke being drawn on the pixel surface. */
  const strokeRef = useRef<MaterialStroke | null>(null);
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
  /** A committed bitmap still decoding; the surface already holds it. */
  const pendingImageRef = useRef<string | null>(null);
  /** Which layer `surfaceRef` holds pixels for. */
  const surfaceLayerRef = useRef<string | null>(null);
  const previewRaf = useRef(0);
  /** Bumped whenever the stage is redrawn from the committed frame, so a live
   *  preview knows the stage no longer holds what it drew. */
  const stageGenRef = useRef(0);
  /** What the brush preview last drew in full: its stroke, on which stage
   *  generation, at which size. Later frames only redraw what the stroke changed. */
  const brushShownRef = useRef<{ stroke: MaterialStroke; gen: number; size: number } | null>(null);

  // Tools need a sheet: an empty layer becomes a 512×512 page. Fill needs
  // pixels: pencil strokes are folded into the bitmap and a surface is kept ready.
  useEffect(() => {
    if (activeTool === "none" || activeTool === "picker") return;
    if (!paintLayer || paintLayer.kind === "group") return;

    // A mask is plain greys: every tool paints it through the pixel surface.
    if (maskMode && paintLayer.mask) {
      const key = `${paintLayer.id}#mask`;
      if (surfaceLayerRef.current !== key) {
        surfaceLayerRef.current = key;
        surfaceRef.current = null;
        surfaceSrc.current = null;
      }
      const mask = paintLayer.mask;
      if (!mask.image) {
        if (surfaceRef.current && surfaceSrc.current === null) return;
        const s = new RasterSurface(
          Math.max(1, Math.round(paintLayer.size.w)),
          Math.max(1, Math.round(paintLayer.size.h))
        );
        const v = mask.fill / 255;
        s.fill({ r: v, g: v, b: v, a: 1 });
        surfaceRef.current = s;
        surfaceSrc.current = null;
        return;
      }
      if (surfaceSrc.current === mask.image) return;
      if (surfaceSrc.current && surfaceSrc.current === pendingImageRef.current) return;
      let cancelled = false;
      const src = mask.image;
      RasterSurface.fromLayer({ ...paintLayer, image: src })
        .then((s) => {
          if (cancelled) return;
          surfaceRef.current = s;
          surfaceSrc.current = src;
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }

    // Adjustment layers have no pixels to paint.
    if (paintLayer.adjust) return;

    if (!paintLayer.image && !paintLayer.strokes?.length) {
      if (paintLayer.size.w !== BLANK_SIZE || paintLayer.size.h !== BLANK_SIZE) {
        const f = editRef.current;
        commit({
          ...f,
          layers: f.layers.map((l) =>
            l.id === paintLayer.id
              ? {
                  ...l,
                  size: { w: BLANK_SIZE, h: BLANK_SIZE },
                  pose: makePose(defaultFitPose(BLANK_SIZE, BLANK_SIZE)),
                }
              : l
          ),
        });
        return;
      }
    }

    // Fill, shapes and the material brushes work on pixels.
    if (activeTool !== "fill" && activeTool !== "brush" && activeTool !== "shape") return;

    // A different layer: its pixels are not the surface we hold.
    if (surfaceLayerRef.current !== paintLayer.id) {
      surfaceLayerRef.current = paintLayer.id;
      surfaceRef.current = null;
      surfaceSrc.current = null;
    }

    if (paintLayer.strokes?.length) {
      let cancelled = false;
      bakeLayerStrokes(paintLayer).then((image) => {
        if (cancelled || !image) return;
        loadBitmap(image)
          .catch(() => null)
          .then(() => {
            if (cancelled) return;
            const f = editRef.current;
            commit({
              ...f,
              layers: f.layers.map((l) =>
                l.id === paintLayer.id ? { ...l, image, strokes: [] } : l
              ),
              flattenKey: null,
            });
          });
      });
      return () => {
        cancelled = true;
      };
    }

    // Blank sheet: a transparent surface of the layer's size.
    if (!paintLayer.image) {
      if (surfaceRef.current && surfaceSrc.current === null) return;
      surfaceRef.current = new RasterSurface(
        Math.max(1, Math.round(paintLayer.size.w)),
        Math.max(1, Math.round(paintLayer.size.h))
      );
      surfaceSrc.current = null;
      return;
    }

    if (surfaceSrc.current === paintLayer.image) return;
    // A stroke was just committed and is still decoding: the surface is newer.
    if (surfaceSrc.current && surfaceSrc.current === pendingImageRef.current) return;
    let cancelled = false;
    const src = paintLayer.image;
    RasterSurface.fromLayer(paintLayer)
      .then((s) => {
        if (cancelled) return;
        surfaceRef.current = s;
        surfaceSrc.current = src;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeTool, paintLayer, commit, maskMode]);

  /** Canvas point → base-layer pixel (position, zoom, rotation and stabilize included). */
  const toLocal = useCallback((cx: number, cy: number) => {
    const m = paintMatrix(editRef.current);
    const inv = m ? matInvert(m) : null;
    return inv ? matApply(inv, { x: cx, y: cy }) : null;
  }, []);

  const surfaceReady = () =>
    !!surfaceRef.current &&
    !!paintLayer &&
    surfaceLayerRef.current === surfaceKey &&
    (maskMode || !paintLayer.strokes?.length) &&
    (surfaceSrc.current === surfaceImage || surfaceSrc.current === pendingImageRef.current);

  /**
   * Live preview while a stroke is in progress: the normal composite, with the
   * live stroke appended to the layer being painted. Earlier strokes come from the
   * compositor's cache, so only the live stroke is rendered each frame.
   */
  const paintPreview = useCallback(() => {
    previewRaf.current = 0;
    const canvas = baseCanvasRef.current;
    const live = liveRef.current;
    const stroke = strokeRef.current;
    const shaping = !!shapeRef.current;
    if (!canvas || !paintLayer || (!live && !stroke && !shaping)) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const f = editRef.current;

    // Material brush (and anything on a mask): the working surface stands in
    // for the layer's pixels or mask, so the stroke shows in its place in the
    // stack, with its blend, opacity and mask.
    if (stroke || shaping || (live && maskMode)) {
      const surface = surfaceRef.current;
      if (!surface) return;
      const changed = stroke ? stroke.previewInto() : null;
      let scratch = scratchRef.current;
      if (!scratch) {
        scratch = document.createElement("canvas");
        scratchRef.current = scratch;
      }
      const sized = scratch.width === surface.width && scratch.height === surface.height;
      if (scratch.width !== surface.width) scratch.width = surface.width;
      if (scratch.height !== surface.height) scratch.height = surface.height;
      const sctx = scratch.getContext("2d");
      if (!sctx) return;

      const dom = domResolver();
      // A mask preview answers for the mask; a pixel preview for the layer.
      const liveId = maskMode ? `${paintLayer.id}#mask` : paintLayer.id;
      // The committed layer is drawn from a decoded image, which the browser
      // resamples like a canvas at "low" whenever it is shown at half size or
      // more (its "high" only takes effect when shrinking further). The live
      // canvas is drawn the same way, so nothing changes when the pen lifts.
      const painted = findLayer(f.layers, paintLayer.id);
      const quality: ImageSmoothingQuality =
        painted && stageDensity(stageMatrix(painted, canvas.width)) >= 0.5 ? "low" : "high";
      const resolve: BitmapResolver = (l) =>
        l.id === liveId
          ? { layerId: liveId, image: scratch!, width: scratch!.width, height: scratch!.height, quality }
          : dom(l);
      const liveFrame: Frame = {
        ...f,
        // Any non-null image makes the (maybe blank) layer or mask render;
        // the resolver hands back the live surface for it.
        layers: f.layers.map((l) =>
          l.id !== paintLayer.id
            ? l
            : maskMode && l.mask
              ? { ...l, mask: { ...l.mask, image: "live" } }
              : { ...l, image: "live" }
        ),
      };
      const options = { background, resolve, checkerboard: true, smoothing: true };

      // A brush stroke changes a few pixels a frame. Once its first frame is on
      // the stage, later frames convert and upload only those pixels and
      // recomposite only the stage pixels they land on. Anything else that
      // redraws the stage (a commit, a decode) bumps the generation, and the
      // next frame starts over in full.
      const shown = brushShownRef.current;
      const continuing =
        !!stroke && !shaping && !live && sized &&
        shown?.stroke === stroke && shown.gen === stageGenRef.current && shown.size === canvas.width;
      if (continuing) {
        if (!changed) return;
        const part = surface.toImageData(changed);
        if (part.width > 0 && part.height > 0) {
          sctx.putImageData(new ImageData(part.data, part.width, part.height), changed.x, changed.y);
        }
        const area = painted ? stageArea(painted, changed, canvas.width) : null;
        if (!area) return;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.beginPath();
        ctx.rect(area.x, area.y, area.w, area.h);
        ctx.clip();
        drawFrameLayers(ctx, liveFrame, canvas.width, options);
        ctx.restore();
        return;
      }

      const { data } = surface.toImageData();
      const img = new ImageData(data, surface.width, surface.height);
      if (live) renderMaskStroke(img, live.stroke);
      sctx.putImageData(img, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      drawFrameLayers(ctx, liveFrame, canvas.width, options);
      brushShownRef.current =
        stroke && !shaping && !live ? { stroke, gen: stageGenRef.current, size: canvas.width } : null;
      return;
    }
    if (!live) return;

    // Cursor tip follows pressure, at most once a frame and in small steps,
    // so the whole editor does not re-render on every pen sample.
    const pts = live.stroke.pts;
    if (pts.length >= 7) {
      const q = Math.round(pts[pts.length - 5] * 20) / 20;
      setTipPressure((cur) => (cur === q ? cur : q));
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawFrameLayers(
      ctx,
      {
        ...f,
        layers: f.layers.map((l) =>
          l.id === paintLayer.id ? { ...l, strokes: [...(l.strokes ?? []), live.stroke] } : l
        ),
      },
      canvas.width,
      { background, resolve: domResolver(), checkerboard: true, smoothing: true }
    );
  }, [paintLayer, background, maskMode]);

  const schedulePreview = useCallback(() => {
    if (!previewRaf.current) {
      previewRaf.current = requestAnimationFrame(paintPreview);
    }
  }, [paintPreview]);

  useEffect(
    () => () => {
      if (previewRaf.current) cancelAnimationFrame(previewRaf.current);
    },
    []
  );

  /** A pencil or eraser stroke drawn into mask pixels (layer space, 1:1). */
  function renderMaskStroke(
    img: { data: Uint8ClampedArray; width: number; height: number },
    stroke: PencilStroke
  ): void {
    renderStrokes(img, 0, 0, [stroke], {
      matrix: MAT_IDENTITY,
      surfaceW: img.width,
      surfaceH: img.height,
      clip: null,
    });
  }

  /** Write the surface back into the layer being painted (or its mask). */
  const commitSurface = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface || !paintLayer) return;
    const out = surface.commit();
    if (!out) return;
    surfaceSrc.current = out.image;
    pendingImageRef.current = out.image;
    // Decode the new bitmap before swapping it in, so the canvas never
    // redraws for a moment without the stroke (the flicker on pen-up).
    loadBitmap(out.image)
      .catch(() => null)
      .then(() => {
        if (surfaceSrc.current !== out.image) return; // a newer stroke already landed
        pendingImageRef.current = null;
        const f = editRef.current;
        commit({
          ...f,
          layers: f.layers.map((l) =>
            l.id !== paintLayer.id
              ? l
              : maskMode && l.mask
                ? { ...l, mask: { ...l.mask, image: out.image } }
                : { ...l, image: out.image }
          ),
          flattenKey: null,
        });
      });
  }, [paintLayer, commit, maskMode]);

  /** One pointer sample in base-layer pixels. Takes a React event or a native (coalesced) one. */
  const pointSample = (
    e: Pick<PointerEvent, "pressure" | "pointerType" | "timeStamp" | "tiltX" | "tiltY" | "twist">,
    local: { x: number; y: number }
  ) => {
    // a leaning pen: how far it leans (tilt) and toward where (azimuth)
    const tx = Math.tan(((e.tiltX || 0) * Math.PI) / 180);
    const ty = Math.tan(((e.tiltY || 0) * Math.PI) / 180);
    return {
      x: local.x,
      y: local.y,
      pressure: normalizePressure(e.pressure, reportsPressure(e)),
      tilt: Math.atan(Math.hypot(tx, ty)),
      azimuth: Math.atan2(ty, tx),
      twist: ((e.twist || 0) * Math.PI) / 180,
      time: e.timeStamp,
    };
  };

  /**
   * One pencil sample: layer-space position (float, unrounded), pressure at
   * full device precision, tilt and lean direction (converted into layer
   * space), barrel twist and time.
   */
  const pencilSample = (ev: PointerEvent, t0: number): number[] | null => {
    const rect = canvasContainerRef.current?.getBoundingClientRect() ?? null;
    const p = screenToCanvas({ x: ev.clientX, y: ev.clientY }, rect, view);
    const m = paintMatrix(editRef.current);
    const inv = m ? matInvert(m) : null;
    if (!inv) return null;
    const local = matApply(inv, p);

    const isPen = ev.pointerType === "pen";
    const pressure = isPen
      ? Math.min(1, Math.max(0, ev.pressure))
      : ev.pointerType === "touch" && ev.pressure > 0 && ev.pressure !== 0.5
        ? Math.min(1, ev.pressure)
        : MOUSE_PRESSURE;

    let tilt = 0;
    let azimuth = 0;
    if (isPen) {
      const pe = ev as PointerEvent & { altitudeAngle?: number; azimuthAngle?: number };
      let altitude: number;
      let screenAz: number;
      if (typeof pe.altitudeAngle === "number" && typeof pe.azimuthAngle === "number") {
        altitude = pe.altitudeAngle;
        screenAz = pe.azimuthAngle;
      } else {
        const tx = Math.tan(((ev.tiltX ?? 0) * Math.PI) / 180);
        const ty = Math.tan(((ev.tiltY ?? 0) * Math.PI) / 180);
        const lean = Math.hypot(tx, ty);
        altitude = lean > 0 ? Math.atan(1 / lean) : Math.PI / 2;
        screenAz = Math.atan2(ty, tx);
      }
      // Ignore the first ~10° of lean (a pen is never perfectly upright).
      tilt = Math.min(1, Math.max(0, (Math.PI / 2 - altitude - 0.17) / 0.87));
      // Screen direction → canvas (undo view rotation) → layer space.
      const va = screenAz - (view.rotation * Math.PI) / 180;
      const dx = Math.cos(va);
      const dy = Math.sin(va);
      azimuth = Math.atan2(inv.b * dx + inv.d * dy, inv.a * dx + inv.c * dy);
    }
    const twist = (((ev as PointerEvent).twist ?? 0) * Math.PI) / 180;
    return [local.x, local.y, pressure, tilt, azimuth, twist, ev.timeStamp - t0];
  };

  /** Returns true when a paint tool consumed the event. */
  const paintDown = (e: React.PointerEvent<HTMLCanvasElement>): boolean => {
    if (activeTool === "none" || isPlaying) return false;
    const rect = canvasContainerRef.current?.getBoundingClientRect() ?? null;
    const p = screenToCanvas({ x: e.clientX, y: e.clientY }, rect, view);

    if (activeTool === "picker") {
      const stage = baseCanvasRef.current;
      const ctx = stage?.getContext("2d");
      if (stage && ctx) {
        const k = stage.width / CANVAS_SIZE;
        const d = ctx.getImageData(
          Math.max(0, Math.min(stage.width - 1, Math.floor(p.x * k))),
          Math.max(0, Math.min(stage.height - 1, Math.floor(p.y * k))),
          1,
          1
        ).data;
        if (d[3] > 0) {
          setPaintColor(toHex({ r: d[0] / 255, g: d[1] / 255, b: d[2] / 255, a: 1 }));
          setPaintTool("pencil");
        }
      }
      return true;
    }

    const local = toLocal(p.x, p.y);
    // A group has no pixels to paint; a locked group protects what is inside it.
    if (!local || !paintLayer || paintLayer.kind === "group" || isLockedIn(editFrame.layers, paintLayer)) return true;
    if (paintLayer.adjust && !maskMode) return true;
    const lockAlpha = !maskMode && !!paintLayer.alphaLock;

    if (activeTool === "fill") {
      if (!surfaceReady()) return true;
      const surface = surfaceRef.current!;
      const color = paintRGBA();
      onHistoryCommit?.();
      const before = lockAlpha ? surface.data.slice() : null;
      const res = floodFill(surface, {
        seed: local,
        color,
        opacity: 1,
        blend: "normal",
        tolerance: 0.15,
        contiguous: true,
        connectivity: 4,
        grow: 0,
        feather: 0,
      } as FloodFillSettings);
      if (before && res.pixelsFilled > 0) surface.keepAlpha(before, res.bounds);
      if (res.pixelsFilled > 0) commitSurface();
      return true;
    }

    if (activeTool === "shape") {
      if (!surfaceReady()) return true;
      onHistoryCommit?.();
      e.currentTarget.setPointerCapture(e.pointerId);
      shapeRef.current = { start: local, snap: surfaceRef.current!.snapshot(), drew: false };
      return true;
    }

    // Alpha lock keeps every pixel's alpha, so the eraser has nothing to do.
    if (activeTool === "eraser" && lockAlpha) return true;
    // Mask strokes are baked into the mask's pixels on pen-up.
    if (maskMode && !surfaceReady()) return true;

    // pencil / eraser: record the stroke's physics
    onHistoryCommit?.();
    e.currentTarget.setPointerCapture(e.pointerId);
    const scale = Math.max(1e-6, Math.abs(paintLayer.pose.scale.x));
    if (activeTool === "brush") {
      if (!surfaceReady()) return true;
      strokeRef.current = new MaterialStroke(surfaceRef.current!, {
        brush: brushSpecNow,
        color: paintRGBA(),
        radius: brushNow.size / scale,
        intensity: brushNow.intensity,
        material: brushNow.material,
        angle: (brushNow.angle * Math.PI) / 180,
        blend: brushNow.mode,
        // a pen (or a stylus the browser calls "touch") has real pressure;
        // a mouse or finger gets the brush's own stand-in
        hasPressure: reportsPressure(e),
        scale,
        lockAlpha,
      });
      strokeRef.current.addSample(pointSample(e, local));
      schedulePreview();
      return true;
    }
    const stroke: PencilStroke & { pts: number[] } = {
      id: createStrokeId(),
      // On a mask the eraser paints the hiding grey, the pencil the paint grey.
      kind: activeTool === "eraser" && !maskMode ? "erase" : "graphite",
      color: maskMode ? toHex(paintRGBA(activeTool === "eraser")) : paintColor,
      size: brushSize / scale,
      seed: paintLayer.strokes?.[0]?.seed ?? seedFromString(paintLayer.id),
      ...(lockAlpha && { lockAlpha: true }),
      pts: [],
    };
    markLiveStroke(stroke);
    const t0 = e.timeStamp;
    const first = pencilSample(e.nativeEvent, t0);
    if (first) {
      stroke.pts.push(...first);
      setTipPressure(first[2]);
    }
    liveRef.current = { stroke, t0 };
    schedulePreview();
    return true;
  };

  /** Redraw the dragged shape from the clean snapshot, up to the pointer. */
  const drawShapeTo = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = shapeRef.current;
    const surface = surfaceRef.current;
    if (!drag || !surface || !paintLayer) return;
    const rect = canvasContainerRef.current?.getBoundingClientRect() ?? null;
    const p = screenToCanvas({ x: e.clientX, y: e.clientY }, rect, view);
    const end = toLocal(p.x, p.y);
    if (!end) return;
    surface.restore(drag.snap);
    if (Math.hypot(end.x - drag.start.x, end.y - drag.start.y) < 1) {
      drag.drew = false;
      schedulePreview();
      return;
    }
    const scale = Math.max(1e-6, Math.abs(paintLayer.pose.scale.x));
    const width = shapeWidth / scale;
    const geom = {
      ...geometryFromDrag(shapeKind, drag.start, end, {
        constrain: e.shiftKey,
        fromCenter: e.altKey,
      }),
      // Arrow heads grow with the line, so a thick arrow still reads as one.
      headLength: Math.max(DEFAULT_ARROW_HEAD_LENGTH / scale, width * 4),
      headWidth: Math.max(DEFAULT_ARROW_HEAD_WIDTH / scale, width * 2.5),
    };
    const color = paintRGBA();
    const solid = shapeFill && shapeKind !== "line" && shapeKind !== "arrow";
    const res = drawShape(surface, geom, {
      fill: solid ? color : null,
      stroke: solid ? null : color,
      strokeWidth: width,
      cornerRadius: 0,
      opacity: 1,
      blend: "normal",
      antialias: 1,
    });
    if (!maskMode && paintLayer.alphaLock) {
      const pad = width + 2;
      const r = rectNormalize(geom.rect);
      surface.keepAlpha(drag.snap.data, {
        x: r.x - pad - geom.headLength,
        y: r.y - pad - geom.headLength,
        w: r.w + 2 * (pad + geom.headLength),
        h: r.h + 2 * (pad + geom.headLength),
      });
    }
    drag.drew = !!(res.fillBounds || res.strokeBounds);
    schedulePreview();
  };

  const paintMove = (e: React.PointerEvent<HTMLCanvasElement>): boolean => {
    if (shapeRef.current) {
      drawShapeTo(e);
      return true;
    }
    const rect = canvasContainerRef.current?.getBoundingClientRect() ?? null;
    // Pens report far more samples than frames: take every one of them.
    const native = e.nativeEvent;
    const batch = native.getCoalescedEvents?.() ?? [];
    const events: PointerEvent[] = batch.length ? batch : [native];

    const stroke = strokeRef.current;
    if (stroke) {
      let fed = false;
      for (const ev of events) {
        const p = screenToCanvas({ x: ev.clientX, y: ev.clientY }, rect, view);
        const local = toLocal(p.x, p.y);
        if (local) {
          stroke.addSample(pointSample(ev, local));
          fed = true;
        }
      }
      if (fed) schedulePreview();
      return true;
    }

    const live = liveRef.current;
    if (!live) return false;
    const pts = live.stroke.pts;
    for (const ev of events) {
      const smp = pencilSample(ev, live.t0);
      if (!smp) continue;
      const n = pts.length;
      if (n >= 7) {
        const d = Math.hypot(smp[0] - pts[n - 7], smp[1] - pts[n - 6]);
        if (d < 0.01 && Math.abs(smp[2] - pts[n - 5]) < 0.01) continue;
      }
      pts.push(...smp);
    }
    schedulePreview();
    return true;
  };

  const paintUp = (e: React.PointerEvent<HTMLCanvasElement>): boolean => {
    const drag = shapeRef.current;
    if (drag) {
      shapeRef.current = null;
      if (previewRaf.current) {
        cancelAnimationFrame(previewRaf.current);
        previewRaf.current = 0;
      }
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      // As with the brush: the preview stays up until the new bitmap decodes.
      if (drag.drew) commitSurface();
      else {
        surfaceRef.current?.restore(drag.snap);
        setDecodeGeneration((g) => g + 1);
      }
      return true;
    }
    const stroke = strokeRef.current;
    if (stroke) {
      strokeRef.current = null;
      if (previewRaf.current) {
        cancelAnimationFrame(previewRaf.current);
        previewRaf.current = 0;
      }
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      // The preview stays on screen until the new bitmap is decoded (no blink).
      if (stroke.end()) commitSurface();
      else setDecodeGeneration((g) => g + 1); // nothing drawn: repaint normally
      return true;
    }
    const live = liveRef.current;
    if (!live) return activeTool !== "none";
    liveRef.current = null;
    setTipPressure(MOUSE_PRESSURE);
    if (previewRaf.current) {
      cancelAnimationFrame(previewRaf.current);
      previewRaf.current = 0;
    }
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (!paintLayer || live.stroke.pts.length === 0) {
      setDecodeGeneration((g) => g + 1);
      return true;
    }
    const done: PencilStroke = { ...live.stroke, pts: live.stroke.pts.slice() };
    if (maskMode) {
      const surface = surfaceRef.current;
      if (!surface) return true;
      const { data } = surface.toImageData();
      const img = { data: new Uint8ClampedArray(data), width: surface.width, height: surface.height };
      renderMaskStroke(img, done);
      surfaceRef.current = RasterSurface.fromImageData(img.data, img.width, img.height);
      commitSurface();
      return true;
    }
    const f = editRef.current;
    commit({
      ...f,
      layers: f.layers.map((l) =>
        l.id === paintLayer.id ? { ...l, strokes: [...(l.strokes ?? []), done] } : l
      ),
      flattenKey: null,
    });
    return true;
  };

  // Shortcuts: P pencil, B brush, E eraser, G fill, I picker, Esc puts the tool away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Ignore keys only while TYPING. A slider or the colour swatch keeps focus
      // after it is used, and must not swallow Esc / B / E from then on.
      const typing =
        !!t &&
        (t.tagName === "TEXTAREA" ||
          t.isContentEditable ||
          (t.tagName === "INPUT" &&
            !["range", "color", "checkbox", "radio", "button"].includes(
              (t as HTMLInputElement).type
            )));
      if (typing) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const map: Record<string, PaintTool> = {
        p: "pencil",
        b: "brush",
        e: "eraser",
        g: "fill",
        i: "picker",
        u: "shape",
      };
      if (map[k]) {
        setPaintTool((cur) => (cur === map[k] ? "none" : map[k]));
        setSizeBarOpen(map[k] === "pencil" || map[k] === "eraser" || map[k] === "shape");
      } else if (e.key === "Escape" && !liveRef.current && !strokeRef.current && !shapeRef.current) {
        // Esc closes the brush panel or the size bar first, then puts the tool away.
        if (brushPanelVisibleRef.current) setBrushPanelOpen(false);
        else if (sizeBarOpenRef.current) setSizeBarOpen(false);
        else setPaintTool("none");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Place the panel beside the tool rail, level with the Brush button, like
  // the rail's flyouts.
  useLayoutEffect(() => {
    if (!brushPanelVisible) return;
    const place = () => {
      const sec = sectionRef.current;
      const rail = paintToolsRef.current;
      if (!sec || !rail) return;
      const s = sec.getBoundingClientRect();
      const r = rail.getBoundingClientRect();
      const btn = rail.querySelector<HTMLElement>('[data-tool="brush"]');
      const top = btn ? btn.getBoundingClientRect().top - s.top - 6 : r.top - s.top;
      setBrushPanelPos({ left: r.right - s.left + 8, top: Math.max(12, top) });
    };
    place();
    const ro = new ResizeObserver(place);
    if (sectionRef.current) ro.observe(sectionRef.current);
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [brushPanelVisible]);

  // Clicking anywhere outside the panel dismisses it — except in the tool
  // column, so the colour can be changed with the panel open (its previews are
  // drawn in that colour) and the Brush icon can toggle it. The listener is on
  // the capture phase and never stops the event, so a click on the canvas both
  // closes the panel and starts the stroke.
  useEffect(() => {
    if (!brushPanelVisible) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (brushPanelRef.current?.contains(t) || paintToolsRef.current?.contains(t))) return;
      setBrushPanelOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [brushPanelVisible]);

  /** Native bitmap dimensions of the current frame's base layer. */
  const nativeSizeRef = useRef({
    w: CANVAS_SIZE,
    h: CANVAS_SIZE,
  });

  useEffect(() => {
    if (base && base.size.w > 0 && base.size.h > 0) {
      nativeSizeRef.current = { w: base.size.w, h: base.size.h };
    }
  }, [base]);

  /* ---------- Interaction locks ---------- */

  const transformsLocked = isPlaying || selectionActive || lassoMode;
  useEffect(() => {
    if (!transformsLocked) return;

    pointers.current.clear();
    dragHistoryCommitted.current = false;
  }, [transformsLocked]);

  const lockRef = useRef({
    locked: true,
    viewRotation: 0,
    viewX: 0,
    viewY: 0,
    hasImage: false,
  });

  useEffect(() => {
    lockRef.current = {
      locked: transformsLocked,
      viewRotation: view.rotation,
      viewX: view.x,
      viewY: view.y,
      hasImage: hasPixels,
    };
  }, [transformsLocked, view.rotation, view.x, view.y, hasPixels]);

  useEffect(() => {
    onSelectionActiveChange?.(selectionActive);
  }, [selectionActive, onSelectionActiveChange]);

  /**
   * Baking a selection flattens the transform into the bitmap, so the lasso is
   * only offered when the bitmap on screen is already 1:1 with the frame.
   *
   * `isFlatDocument` is the layer-aware half of the gate: the bake reads back
   * the COMPOSITE, so with a second layer present it would fuse two layers
   * into the base and silently destroy the stack. Offering the lasso only on a
   * flat document keeps the operation reversible in the sense that matters —
   * no layer is ever lost without the animator asking for it.
   */
  const lassoAvailable =
    !isPlaying &&
    hasPixels &&
    view.x === 0 &&
    view.y === 0 &&
    view.rotation === 0 &&
    isBakeable(editFrame) &&
    isFlatDocument(editFrame);

  /* ---------- Coordinate helpers (screen -> canvas units) ---------- */

  const getScale = useCallback(() => {
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) return { sx: 1, sy: 1 };
    return { sx: CANVAS_SIZE / rect.width, sy: CANVAS_SIZE / rect.height };
  }, [canvasContainerRef]);

  const toCanvasPoint = useCallback(
    (clientX: number, clientY: number) => {
      const rect = canvasContainerRef.current?.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) return { x: 0, y: 0 };

      return {
        x: ((clientX - rect.left) * CANVAS_SIZE) / rect.width,
        y: ((clientY - rect.top) * CANVAS_SIZE) / rect.height,
      };
    },
    [canvasContainerRef]
  );

  /* ---------- History (delegated to parent) ---------- */

  const commitHistory = useCallback(() => {
    onHistoryCommit?.();
  }, [onHistoryCommit]);

  const pushHistory = useCallback(
    (frame: Frame) => {
      onHistoryPushFrame?.(frame);
    },
    [onHistoryPushFrame]
  );

  /* ---------- Bitmap decoding ---------- */

  /**
   * Decode every visible layer bitmap into the SHARED cache.
   *
   * Shared is the operative word: `domResolver()` reads from
   * lib/layers/flatten's cache, so a private cache here would leave the
   * compositor seeing nothing at all. One cache, one owner.
   */
  useEffect(() => {
    let cancelled = false;
    const pending = [
      ...frame.layers,
      ...onionFrames.flatMap((o) => o.frame.layers),
    ].filter((l) => (l.image || l.mask?.image) && l.visible);

    if (!pending.length) return;

    preloadFrameBitmaps(pending).then(() => {
      if (!cancelled) setDecodeGeneration((g) => g + 1);
    });

    return () => {
      cancelled = true;
    };
  }, [frame.layers, onionFrames]);

  /**
   * Resolve any layer whose native size is still unknown.
   *
   * Geometry is SAFE in the interim — a 0×0 content box hit-tests as empty and
   * composites as nothing, rather than as a wrong-sized rectangle — but bounds
   * and handles are only correct once the size lands, so it is resolved as
   * soon as the bitmap decodes.
   */
  useEffect(() => {
    if (isPlaying) return;

    const unsized = editFrame.layers.find(
      (l) => l.image && (l.size.w <= 0 || l.size.h <= 0)
    );
    if (!unsized || !unsized.image) return;

    let cancelled = false;
    loadBitmap(unsized.image)
      .then((img) => {
        if (cancelled) return;
        editor.dispatch({
          type: "layer/sizeKnown",
          id: unsized.id,
          width: img.naturalWidth,
          height: img.naturalHeight,
        });
      })
      .catch(() => {
        /* undecodable layer: leave it sized 0×0, which renders as nothing */
      });

    return () => {
      cancelled = true;
    };
  }, [editFrame.layers, editor, isPlaying]);

  // A pencil layer shown as a stand-in during a view change has been rendered
  // exactly: repaint.
  useEffect(() => onStrokeRefine(() => setDecodeGeneration((g) => g + 1)), []);

  /* ---------- Base layer (full composite) ---------- */

  /**
   * ONE composite call for the whole document.
   *
   * This is the same function the GIF exporter runs, at a different surface
   * size, so what the animator sees is what the export contains. The previous
   * architecture had four independent draw paths reading `frame.x/y` directly,
   * which meant a second layer required four correct edits instead of one.
   */
   useEffect(() => {
  const canvas = baseCanvasRef.current;
  if (!canvas) return;

  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return;

  // Always repaint from a clean surface.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Drawn at the screen's pixel density (stageRes), and layer pixels are
  // resampled smoothly, as the GIF export does: drawn nearest-neighbour, any
  // layer that is zoomed, scaled or nudged by a fraction of a pixel turns its
  // anti-aliased edges into uneven blocks.
  drawFrameLayers(ctx, frame, canvas.width, {
    background,
    resolve: domResolver(),
    checkerboard: true,
    interactive: true,
    smoothing: true,
  });
  stageGenRef.current++;
  }, [
      frame,
      frame.layers,
      frame.crop,
      frame.stab?.dx,
      frame.stab?.dy,
      background,
      view.x,
      view.y,
    view.rotation,
    decodeGeneration,
    stageRes,
  ]);

  /* ---------- Onion skin (honours each neighbour's own transform) ---------- */

  useEffect(() => {
    const canvas = onionCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const size = canvas.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);

    if (!onionSkin || !onionFrames.length) return;

    const scratch = (onionScratch.current ??= document.createElement("canvas"));
    scratch.width = size;
    scratch.height = size;
    const sctx = scratch.getContext("2d");
    if (!sctx) return;

    // Farthest first, so nearer frames sit on top; each step away fades a little more.
    const ordered = [...onionFrames].sort((a, b) => Math.abs(b.offset) - Math.abs(a.offset));
    for (const { frame: neighbour, offset } of ordered) {
      if (!neighbour.layers.some((l) => (l.image || l.strokes?.length) && l.visible)) continue;

      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.globalCompositeOperation = "source-over";
      sctx.globalAlpha = 1;
      sctx.clearRect(0, 0, size, size);
      drawFrameLayers(sctx, neighbour, size, {
        background: ONION_BACKGROUND,
        resolve: domResolver(),
        checkerboard: false,
        smoothing: true,
      });

      sctx.setTransform(1, 0, 0, 1, 0, 0);
      sctx.globalCompositeOperation = "source-atop";
      sctx.globalAlpha = 0.65;
      sctx.fillStyle = offset < 0 ? ONION_BEFORE : ONION_AFTER;
      sctx.fillRect(0, 0, size, size);

      ctx.globalAlpha = Math.max(0.25, 1 - (Math.abs(offset) - 1) * 0.18);
      ctx.drawImage(scratch, 0, 0);
    }
    ctx.globalAlpha = 1;
  }, [onionSkin, onionFrames, decodeGeneration, stageRes]);

  /* ---------- Floating selection layer ---------- */

  useEffect(() => {
    if (!selectionCanvas) return;

    const canvas = selectionCanvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(selectionCanvas, 0, 0);
  }, [selectionCanvas, selectionSize]);

  const clearSelectionState = useCallback(() => {
    setSelectionCanvas(null);
    baseHoleCanvas.current = null;
    selectionFlowImage.current = null;
    setSelectionOffset({ x: 0, y: 0 });
    setSelectionSize({ w: 0, h: 0 });
    setSelectionActive(false);
    preCutFrame.current = null;
  }, []);

  useEffect(() => {
    if (preCutFrame.current) {
      onChangeRef.current(preCutFrame.current);
    }

    clearSelectionState();
    setLassoMode(false);
    setPoints([]);
    setIsDrawing(false);
  }, [projectId, frameId, clearSelectionState]);

  /**
   * Write a bitmap into the BASE LAYER and keep every invariant.
   *
   * The lasso is the one destructive pixel path in the editor, and it must not
   * bypass the compatibility contract. Three things happen together, or none
   * of them mean anything:
   *
   *  1. the base layer's pixels are replaced and its crop dropped;
   *  2. `clearTransforms` zeroes L1 AND L2 — zeroing only L1 would re-apply
   *     the stabilization correction to already-corrected pixels on the next
   *     render;
   *  3. the base pose is reset to the default contain-fit for the new size, so
   *     the pose agrees with the legacy fields `clearTransforms` just zeroed,
   *     and `flattenKey` is invalidated so `frame.image` recomposites.
   */
  const writeBaseImage = useCallback(
    (source: Frame, image: string, width: number, height: number): Frame => {
      const target = baseLayer(source.layers);
      if (!target) return { ...source, image, flattenKey: null };

      const layers = source.layers.map((l) =>
        l.id === target.id
          ? {
              ...l,
              image,
              size: { w: width, h: height },
              crop: null,
              pose: makePose(defaultFitPose(width, height)),
              // The cut came from the rendered canvas, strokes included.
              strokes: [],
            }
          : l
      );

      return clearTransforms({
        ...source,
        layers,
        image,
        flattenKey: null,
      });
    },
    []
  );

  /* ---------- Create selection (commits the hole immediately) ---------- */

  const createSelection = useCallback(() => {
    if (!lassoAvailable) return;
    if (points.length < 3) return;

    // The cut works on the document's own 512 px grid, with layer pixels
    // unresampled, so the hole and the piece go back into the layer exactly.
    // The stage canvas is drawn at screen density, so the lasso renders its
    // own copy rather than reading that one.
    const source = document.createElement("canvas");
    source.width = CANVAS_SIZE;
    source.height = CANVAS_SIZE;
    const srcCtx = source.getContext("2d");
    if (!srcCtx) return;
    drawFrameLayers(srcCtx, frame, CANVAS_SIZE, {
      background,
      resolve: domResolver(),
      checkerboard: true,
    });

    const minX = Math.max(0, Math.floor(Math.min(...points.map((p) => p.x))));
    const minY = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y))));
    const maxX = Math.min(
      CANVAS_SIZE,
      Math.ceil(Math.max(...points.map((p) => p.x)))
    );
    const maxY = Math.min(
      CANVAS_SIZE,
      Math.ceil(Math.max(...points.map((p) => p.y)))
    );

    const width = maxX - minX;
    const height = maxY - minY;

    if (width < 1 || height < 1) {
      setPoints([]);
      return;
    }

    const cut = document.createElement("canvas");
    cut.width = width;
    cut.height = height;

    const cutCtx = cut.getContext("2d");
    if (!cutCtx) return;

    const tracePath = (
      ctx: CanvasRenderingContext2D,
      ox: number,
      oy: number
    ) => {
      ctx.beginPath();
      ctx.moveTo(points[0].x - ox, points[0].y - oy);
      for (const p of points.slice(1)) ctx.lineTo(p.x - ox, p.y - oy);
      ctx.closePath();
    };

    cutCtx.save();
    tracePath(cutCtx, minX, minY);
    cutCtx.clip();
    cutCtx.drawImage(source, -minX, -minY);
    cutCtx.restore();

    srcCtx.save();
    tracePath(srcCtx, 0, 0);
    srcCtx.clip();
    srcCtx.clearRect(minX, minY, width, height);
    srcCtx.restore();

    // Snapshot the base canvas containing the hole onto an offscreen canvas.
    const holeCopy = document.createElement("canvas");
    holeCopy.width = CANVAS_SIZE;
    holeCopy.height = CANVAS_SIZE;

    const holeCtx = holeCopy.getContext("2d");
    if (holeCtx) {
      holeCtx.drawImage(source, 0, 0);
    }
    baseHoleCanvas.current = holeCopy;

    // The cut is destructive, so it goes into the base layer now — otherwise
    // the next redraw repaints the original and the selection becomes a
    // duplicate.
    const { w: nw0, h: nh0 } = nativeSizeRef.current;
    const holeDataUrl = toNativeResolution(source, nw0, nh0);

    preCutFrame.current = { ...editRef.current };
    commit(writeBaseImage(editRef.current, holeDataUrl, nw0, nh0));
    selectionFlowImage.current = holeDataUrl;

    selectionStart.current = { x: minX, y: minY };
    setSelectionCanvas(cut);
    setSelectionOffset({ x: minX, y: minY });
    setSelectionSize({ w: width, h: height });
    setSelectionActive(true);

    setLassoMode(false);
    setPoints([]);
  }, [lassoAvailable, points, commit, writeBaseImage, frame, background]);

  /**
   * Downscale a 512-space composite back to the frame's NATIVE bitmap size.
   *
   * Without this, baking a 128 px cell writes a 512×512 image into a project
   * whose other frames are 128×128 — and decode.ts then rejects the project with
   * `dimension-mismatch`, because the solver's lattice Ω must be identical across
   * frames. Symptom: "lasso-edit one frame, then Auto Stabilize throws."
   *
   * The 128→512→128 round trip is lossy. The correct long-term fix is to run the
   * whole selection flow in source space; this keeps dimensions invariant until
   * that refactor happens.
   */
  function toNativeResolution(
    composite: HTMLCanvasElement,
    nativeWidth: number,
    nativeHeight: number
  ): string {
    if (
      nativeWidth <= 0 ||
      nativeHeight <= 0 ||
      (composite.width === nativeWidth && composite.height === nativeHeight)
    ) {
      return composite.toDataURL("image/png");
    }

    const out = document.createElement("canvas");
    out.width = nativeWidth;
    out.height = nativeHeight;

    const ctx = out.getContext("2d");
    if (!ctx) return composite.toDataURL("image/png");

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(composite, 0, 0, nativeWidth, nativeHeight);
    return out.toDataURL("image/png");
  }

  /* ---------- Apply / cancel selection ---------- */

  const applySelection = useCallback(() => {
    if (isPlaying || !selectionCanvas || !baseHoleCanvas.current) {
      clearSelectionState();
      return;
    }

    const composite = document.createElement("canvas");
    composite.width = CANVAS_SIZE;
    composite.height = CANVAS_SIZE;

    const ctx = composite.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(baseHoleCanvas.current, 0, 0);
    ctx.drawImage(selectionCanvas, selectionOffset.x, selectionOffset.y);

    if (preCutFrame.current) {
      pushHistory(preCutFrame.current);
    }

    const { w: nw, h: nh } = nativeSizeRef.current;
    const baked = toNativeResolution(composite, nw, nh);

    commit(writeBaseImage(editRef.current, baked, nw, nh));

    clearSelectionState();
  }, [
    isPlaying,
    selectionCanvas,
    selectionOffset,
    pushHistory,
    commit,
    clearSelectionState,
    writeBaseImage,
  ]);

  const cancelSelection = useCallback(() => {
    if (preCutFrame.current) {
      // Restore the WHOLE pre-cut frame, layers included: the cut replaced the
      // base layer's bitmap and reset its pose, so restoring only the legacy
      // fields would leave the hole in place.
      commit({ ...preCutFrame.current, flattenKey: null });
    }

    clearSelectionState();
  }, [commit, clearSelectionState]);

  useEffect(() => {
    if (isPlaying && selectionActive) {
      cancelSelection();
    }
  }, [isPlaying, selectionActive, cancelSelection]);

  useEffect(() => {
  if (!selectionActive || !selectionFlowImage.current) return;

  const baseImg = editFrame.layers.find((l) => l.kind === "base")?.image;

  if (baseImg !== selectionFlowImage.current) {
    clearSelectionState();
  }
}, [editFrame.layers, selectionActive, clearSelectionState]);
  /* ---------- Drag floating selection ---------- */

  const releaseDragListeners = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      releaseDragListeners.current?.();
      releaseDragListeners.current = null;
    };
  }, []);

  const clampSelectionOffset = useCallback(
    (p: { x: number; y: number }) => ({
      x: Math.max(0, Math.min(p.x, Math.max(0, CANVAS_SIZE - selectionSize.w))),
      y: Math.max(0, Math.min(p.y, Math.max(0, CANVAS_SIZE - selectionSize.h))),
    }),
    [selectionSize]
  );

  const startSelectionDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!selectionActive) return;
    if (e.button !== 0) return;

    const canvas = e.currentTarget;
    canvas.setPointerCapture(e.pointerId);

    const startX = e.clientX;
    const startY = e.clientY;
    const start = { ...selectionOffset };
    const { sx, sy } = getScale();

    const move = (ev: PointerEvent) => {
      setSelectionOffset(
        clampSelectionOffset({
          x: start.x + (ev.clientX - startX) * sx,
          y: start.y + (ev.clientY - startY) * sy,
        })
      );
    };

    let up: () => void;

    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      releaseDragListeners.current = null;
    };

    up = () => {
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
      cleanup();
    };

    releaseDragListeners.current?.();
    releaseDragListeners.current = cleanup;

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  /* ---------- Drag whole image ---------- */

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragHistoryCommitted = useRef(false);
  const dragOrigin = useRef({ pointerX: 0, pointerY: 0 });

  /**
   * Legacy "drag anywhere to move the artwork".
   *
   * Reached only when the layer editor declined the gesture, i.e. the pointer
   * hit empty space. It now dispatches `xf/move` on the BASE LAYER instead of
   * writing `frame.x/y`: the pose is the single source of truth, and
   * `syncBaseFromLegacy` re-derives x/y from it after every action — so a
   * direct write would be silently overwritten by the next mutation.
   */
    
    // After
const handleCanvasPointerDown = (
  e: React.PointerEvent<Element>
) => {
  if (!hasPixels || transformsLocked) return;


    // Only the left mouse button can drag the image.
    if (e.button !== 0) return;
    if (!base || base.locked) return;

    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    e.currentTarget.setPointerCapture(e.pointerId);

    if (pointers.current.size === 1 && !dragHistoryCommitted.current) {
      commitHistory();
      dragHistoryCommitted.current = true;

      dragOrigin.current = {
        pointerX: e.clientX,
        pointerY: e.clientY,
      };
    }
  };

  // After
const handleCanvasPointerMove = (
  e: React.PointerEvent<Element>
) => {
  if (!pointers.current.has(e.pointerId)) return;

    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Two fingers means pinch, not pan.
    if (pointers.current.size !== 1) return;

    const { sx, sy } = getScale();

    // Incremental delta against the LAST pointer position, so the artwork
    // tracks the cursor exactly even if a frame is dropped.
    const delta = {
      x: (e.clientX - dragOrigin.current.pointerX) * sx,
      y: (e.clientY - dragOrigin.current.pointerY) * sy,
    };
    dragOrigin.current = { pointerX: e.clientX, pointerY: e.clientY };

    if (delta.x === 0 && delta.y === 0) return;

    editor.dispatch({ type: "xf/move", selection: baseSelection, delta });
  };

    // After
const handleCanvasPointerUp = (
  e: React.PointerEvent<Element>
) => {
  pointers.current.delete(e.pointerId);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }

    if (pointers.current.size === 0) {
      dragHistoryCommitted.current = false;
      return;
    }

    // One finger left: rebase the drag on it so motion stays continuous.
    if (pointers.current.size === 1) {
      const [remaining] = pointers.current.values();

      dragOrigin.current = {
        pointerX: remaining.x,
        pointerY: remaining.y,
      };
    }
  };

  /* ---------- Freehand lasso ---------- */

  const startLasso = (e: React.PointerEvent<Element>) => {
    if (!lassoMode) return;

    e.currentTarget.setPointerCapture(e.pointerId);

    const pt = toCanvasPoint(e.clientX, e.clientY);

    setPoints((prev) => {
      if (prev.length === 0) return [pt];

      const last = prev[prev.length - 1];
      const dx = pt.x - last.x;
      const dy = pt.y - last.y;

      // Ignore accidental clicks at the same spot.
      if (dx * dx + dy * dy < 4) return prev;

      // Continue the existing outline instead of replacing it.
      return [...prev, pt];
    });

    setIsDrawing(true);
  };

  const drawLasso = (e: React.PointerEvent<Element>) => {
    if (!isDrawing) return;

    const { x, y } = toCanvasPoint(e.clientX, e.clientY);

    setPoints((prev) => {
      if (prev.length === 0) return [{ x, y }];

      const last = prev[prev.length - 1];
      const dx = x - last.x;
      const dy = y - last.y;

      if (dx * dx + dy * dy < 4) return prev;

      return [...prev, { x, y }];
    });
  };

  const endLasso = (e?: React.PointerEvent<Element>) => {
    if (e && e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (isDrawing) setIsDrawing(false);
  };

  /* ---------- Native wheel zoom ---------- */

  const wheelHistoryCommitted = useRef(false);
  const wheelReset = useRef<number | null>(null);

  const handleNativeWheel = useCallback(
    (e: WheelEvent) => {
      const el = canvasContainerRef.current;
      if (!el) return;

      const { locked, viewRotation, hasImage } = lockRef.current;

      // Only consume the wheel event when we are actually going to zoom.
      if (locked || !hasImage || viewRotation !== 0) return;

      const primary = editor.primary?.kind === "group" ? null : editor.primary;
      const layer = primary ?? baseLayer(editRef.current.layers);
      if (!layer || isLockedIn(editRef.current.layers, layer)) return;

      e.preventDefault();

      const scale = Math.abs(layer.pose.scale.x);
      if (!(scale > 0)) return;

      const layerFit =
        layer.size.w > 0
          ? fitScale(layer.size.w, layer.size.h, CANVAS_SIZE)
          : 1;

      const oldZoom = scale / layerFit;

      const factor = e.ctrlKey
        ? Math.pow(1.01, -e.deltaY) // pinch
        : e.deltaY < 0
          ? 1.08
          : 1 / 1.08;

      const newZoom = clampZoom(oldZoom * factor);
      if (newZoom === oldZoom) return;

      const k = newZoom / oldZoom;

      if (!wheelHistoryCommitted.current) {
        commitHistory();
        wheelHistoryCommitted.current = true;
      }

      if (wheelReset.current) window.clearTimeout(wheelReset.current);
      wheelReset.current = window.setTimeout(() => {
        wheelHistoryCommitted.current = false;
      }, 120);

      /**
       * Keeps the point under the cursor fixed.
       *
       * The old formula open-coded this as
       *     x = (cx − 256 − viewX)·(1 − k) + k·x0
       * which is exactly a scale about the cursor, expressed in the legacy
       * translate-before-scale vocabulary. `poseScaleAbout` IS that operation,
       * derived rather than transcribed — and it stays correct when the layer
       * is rotated, which the open-coded version was not.
       *
       * `screenToCanvas` undoes the view transform, so the anchor is the
       * document point the cursor is actually over.
       */
      const anchor = screenToCanvas(
        { x: e.clientX, y: e.clientY },
        canvasContainerRef.current?.getBoundingClientRect() ?? null,
        view
      );

      editor.dispatch({
        type: "xf/scaleBy",
        selection: { primary: layer.id, ids: [layer.id] },
        sx: k,
        sy: k,
        center: anchor,
      });
    },
    [canvasContainerRef, commitHistory, editor, view]
  );

  useEffect(() => {
    const el = canvasContainerRef.current;
    if (!el) return;

    el.addEventListener("wheel", handleNativeWheel, { passive: false });

    return () => {
      el.removeEventListener("wheel", handleNativeWheel);
      if (wheelReset.current) window.clearTimeout(wheelReset.current);
    };
  }, [handleNativeWheel, canvasContainerRef]);

  
  /* ---------- Nudge helper ---------- */

  const nudge = (dx: number, dy: number) => {
    if (transformsLocked || !targetLayer) return;
    commitHistory();
    editor.dispatch({
      type: "xf/nudge",
      selection: { primary: targetLayer.id, ids: [targetLayer.id] },
      dx,
      dy,
    });
  };

  const setZoom = (zoom: number) => {
    if (transformsLocked || !targetLayer) return;
    editor.dispatch({
      type: "xf/zoomTo",
      id: targetLayer.id,
      zoom: clampZoom(zoom),
      baseScale: targetBaseScale,
    });
  };

  const resetTransform = () => {
    if (transformsLocked || !targetLayer) return;
    commitHistory();
    editor.dispatch({ type: "xf/reset", id: targetLayer.id });
    onViewChange({ x: 0, y: 0, rotation: 0 });
  };

  /* ---------- Selection keyboard shortcuts ---------- */

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;

      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      if (e.key === "Enter") {
        if (e.repeat) return;

        if (lassoMode && points.length >= 3) {
          e.preventDefault();
          createSelection();
          return;
        }

        if (selectionActive) {
          e.preventDefault();
          applySelection();
        }
        return;
      }

      if (e.key === "Escape") {
        if (e.repeat) return;

        if (selectionActive) {
          e.preventDefault();
          cancelSelection();
          return;
        }

        if (lassoMode) {
          e.preventDefault();
          setLassoMode(false);
          setPoints([]);
          setIsDrawing(false);
        }
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [
    lassoMode,
    selectionActive,
    points.length,
    createSelection,
    applySelection,
    cancelSelection,
  ]);

  /* ---------- Overlay visibility ---------- */

  const showTransformOverlay =
  !isPlaying &&
  !lassoMode &&
  !selectionActive &&
  activeTool === "none" &&
  editor.tool !== "crop" &&
  (editor.selection.ids.length > 0 || editor.tool === "straighten");

  const cursorClass = activeTool === "pencil" || activeTool === "brush" || activeTool === "eraser"
    ? "cursor-none"
    : lassoMode || activeTool !== "none"
    ? "cursor-crosshair"
    : editor.tool === "crop" || editor.tool === "straighten"
      ? "cursor-crosshair"
      : transformsLocked || !hasPixels
        ? "cursor-default"
        : "cursor-grab";

  return (
    <section
      ref={sectionRef}
      className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden workspace-dots pl-[88px]"
    >
      <div
        ref={canvasContainerRef}
        data-guides="idle"
        // Guides follow the pointer without re-rendering the canvas.
        onPointerEnter={(e) => { e.currentTarget.dataset.guides = "near"; }}
        onPointerLeave={(e) => { e.currentTarget.dataset.guides = "idle"; }}
        onPointerDownCapture={(e) => { e.currentTarget.dataset.guides = "drag"; }}
        onPointerUpCapture={(e) => { e.currentTarget.dataset.guides = "near"; }}
        onPointerCancelCapture={(e) => { e.currentTarget.dataset.guides = "idle"; }}
        className="relative h-[512px] w-[512px] shrink-0 overflow-hidden rounded-stage bg-stage shadow-stage transition-transform duration-200 ease-out"
        style={{
          touchAction: "none",
          // Pointer maths reads this element's on-screen rect, so a CSS
          // scale keeps every tool exact while the card grows.
          transform: `scale(${stagePx / CANVAS_SIZE})`,
        }}
      >
        
        {/* ---------- Canvas layer ---------- */}
        <div
          className={`absolute inset-0 ${cursorClass}`}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragOver(false);

            const file = e.dataTransfer.files?.[0];
            if (!file || !file.type.startsWith("image/")) return;

            // Finish any floating selection before replacing the bitmap.
            if (selectionActive) {
              cancelSelection();
            }

            // Ignore drops while playback is running.
            if (isPlaying) return;

            onImageDrop?.(file);
          }}
          onDoubleClick={() => {
            if (!isPlaying && !hasPixels && activeTool === "none") onImport?.();
          }}
          
onPointerCancel={(e) => {
  endLasso(e);
  editor.onPointerUp(e);
  handleCanvasPointerUp(e);
}}
        >
          <div
            className="absolute inset-0"
            style={{
              transform: `translate(${view.x}px, ${view.y}px) rotate(${view.rotation}deg)`,
              // Rotate about the centre of the frame, not the top-left corner.
              transformOrigin: `${CANVAS_SIZE / 2}px ${CANVAS_SIZE / 2}px`,
            }}
          >
            
            
            <canvas
  ref={baseCanvasRef}
  width={stageRes}
  height={stageRes}
  className="absolute inset-0 h-full w-full"
  onPointerDown={(e) => {
    if (paintDown(e)) return;

    if (lassoMode) {
      startLasso(e);
      return;
    }

    if (editor.onPointerDown(e)) return;
    handleCanvasPointerDown(e);
  }}
  onPointerMove={(e) => {
    setBrushPos(
      screenToCanvas(
        { x: e.clientX, y: e.clientY },
        canvasContainerRef.current?.getBoundingClientRect() ?? null,
        view
      )
    );
    if (paintMove(e)) return;

    if (lassoMode) {
      drawLasso(e);
      return;
    }

    editor.onPointerMove(e);
    handleCanvasPointerMove(e);
  }}
  onPointerLeave={() => setBrushPos(null)}
  onPointerUp={(e) => {
    if (paintUp(e)) return;

    endLasso(e);
    editor.onPointerUp(e);
    handleCanvasPointerUp(e);
  }}
  onPointerCancel={(e) => {
    if (paintUp(e)) return;
    endLasso(e);
    editor.onPointerUp(e);
    handleCanvasPointerUp(e);
  }}
/>

            {selectionCanvas && (
              <canvas
                ref={selectionCanvasRef}
                width={selectionSize.w}
                height={selectionSize.h}
                onPointerDown={startSelectionDrag}
                className="absolute cursor-move"
                style={{
                  transform: `translate(${selectionOffset.x}px, ${selectionOffset.y}px)`,
                  width: selectionSize.w,
                  height: selectionSize.h,
                  zIndex: 20,
                }}
              />
            )}

            {!hasPixels && activeTool === "none" && !isPlaying && (
              <div className="pointer-events-none absolute inset-0 flex h-full items-center justify-center gap-3">
                <button
                  onClick={() => setPaintTool("pencil")}
                  className="pointer-events-auto rounded-ctrl bg-primary hoverable px-4 py-2 text-sm font-medium text-on-primary"
                >
                  Start drawing
                </button>
                <button
                  onClick={() => onImport?.()}
                  className="pointer-events-auto rounded-ctrl bg-ctrl-hi px-4 py-2 text-sm font-medium text-ink hoverable"
                >
                  Import image
                </button>
              </div>
            )}

            {/* Onion skin: drawn through the same transform pipeline as the base. */}
            <canvas
              ref={onionCanvasRef}
              width={stageRes}
              height={stageRes}
              className="pointer-events-none absolute inset-0 h-full w-full opacity-30"
            />

            {points.length > 0 && (
              <svg
                width={CANVAS_SIZE}
                height={CANVAS_SIZE}
                className="pointer-events-none absolute inset-0 z-30"
              >
                <path
                  d={`M ${points.map((p) => `${p.x} ${p.y}`).join(" L ")}${
                    isDrawing ? "" : " Z"
                  }`}
                  fill={isDrawing ? "none" : overlay.lassoFill}
                  stroke={overlay.lasso}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle cx={points[0].x} cy={points[0].y} r={5} fill={overlay.lasso} />
              </svg>
            )}

            {/*
              Transform handles live INSIDE the view transform, so they track
              the artwork when the canvas is rotated. Their positions come from
              the same matrices hit-testing uses, so a handle is always exactly
              where the pointer test expects it.
            */}
            <TransformOverlay
              layers={editFrame.layers}
              selection={editor.selection}
              primary={editor.primary}
              activeHandle={editor.activeHandle}
              visible={showTransformOverlay}
              straightenLine={editor.straightenLine}
            />
            <BrushCursor
              position={brushPos}
              radius={
                activeTool === "brush" ? brushNow.size : brushSize * widthFactor(tipPressure)
              }
              shape={
                activeTool === "brush" && brushSpecNow.shape === "rect" ? "square" : "round"
              }
              aspect={activeTool === "brush" ? brushSpecNow.aspect ?? 1 : 1}
              angle={
                activeTool === "brush" && brushSpecNow.shape === "rect"
                  ? brushNow.angle + (paintLayer?.pose.rotation ?? 0)
                  : -view.rotation
              }
              color={paintColor}
              erasing={activeTool === "eraser"}
              visible={activeTool === "pencil" || activeTool === "brush" || activeTool === "eraser"}
            />
          </div>

          <EmojiGuides visible={showGuides} mode={guideMode} />

          {/*
            Crop lives OUTSIDE the view transform: it defines the export
            surface, which is a property of the document and not of how the
            document is currently being viewed.
          */}
          <CropOverlay
            draft={editor.cropDraft}
            activeHandle={editor.activeHandle}
            onAspect={editor.setCropAspect}
            onCommit={editor.commitCrop}
            onCancel={editor.cancelCrop}
          />

          {isDragOver && (
            <div className="absolute inset-0 z-40 flex items-center justify-center rounded-stage border-2 border-dashed border-select-line bg-select">
              <div className="rounded-panel bg-panel px-4 py-2 text-sm font-medium text-ink">
                Drop PNG here
              </div>
            </div>
          )}
        </div>

        {/* Alignment crosshair */}
        {alignMode && (
          <svg
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            className="pointer-events-none absolute inset-0 z-10"
          >
            <line
              x1="256"
              y1="0"
              x2="256"
              y2="512"
              stroke={overlay.crosshair}
              strokeWidth="1"
              strokeDasharray="6 6"
            />
            <line
              x1="0"
              y1="256"
              x2="512"
              y2="256"
              stroke={overlay.crosshair}
              strokeWidth="1"
              strokeDasharray="6 6"
            />
            <circle cx="256" cy="256" r="4" fill={overlay.crosshair} />
          </svg>
        )}

      </div>

      {frameInfo && (
        <div
          className="pointer-events-none absolute top-4 z-40 flex h-8 -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-line bg-ctrl px-3.5 text-[13px] text-ink-2"
          // Centred over the card, which centres to the right of the rail.
          style={{ left: "calc(50% + 44px)" }}
          aria-live="polite"
        >
          <span className="font-semibold text-ink">
            Frame <span className="font-mono">{frameInfo.index + 1}</span> of{" "}
            <span className="font-mono">{frameInfo.count}</span>
          </span>
          <span aria-hidden>·</span>
          <span className="font-mono">{frameInfo.seconds.toFixed(2)} s</span>
          <span aria-hidden>·</span>
          <span className="font-mono">{frameInfo.fps} fps</span>
        </div>
      )}

      <ToolRail
        railRef={paintToolsRef}
        activeTool={activeTool}
        onToolClick={(id) => {
          if (id === "brush") {
            // The Brush opens its panel. It is put away with B, Esc or
            // by picking another tool, so a second click can close the
            // panel without dropping the tool.
            if (activeTool !== "brush") {
              setPaintTool("brush");
              setBrushPanelOpen(true);
              setSizeBarOpen(false);
            } else {
              setBrushPanelOpen((open) => !open);
            }
            return;
          }
          if (id === "pencil" || id === "eraser") {
            // Like the Brush: picking opens the size bar, a second click
            // toggles it; Esc or another tool puts the tool away.
            if (activeTool !== id) {
              setPaintTool(id);
              setSizeBarOpen(true);
            } else {
              setSizeBarOpen((open) => !open);
            }
            return;
          }
          setPaintTool(paintTool === id ? "none" : id);
        }}
        brushPanelOpen={brushPanelVisible}
        toolsDisabled={isPlaying}
        paintColor={paintColor}
        onPaintColorChange={setPaintColor}
        background={background}
        onBackgroundChange={isPlaying ? undefined : onBackgroundChange}
        onionSkin={onionSkin}
        onOnionSkinChange={onOnionSkinChange}
        showGuides={showGuides}
        guideMode={guideMode}
        onGuidesChange={onGuidesChange}
        onDuplicateFrame={onDuplicateFrame}
        onClearFrame={onClearFrame}
        onDeleteFrame={onDeleteFrame}
        frameActionsDisabled={isPlaying || selectionActive}
        zoom={targetZoom}
        zoomDisabled={transformsLocked}
        onZoomIn={() => {
          commitHistory();
          setZoom(targetZoom + 0.05);
        }}
        onZoomOut={() => {
          commitHistory();
          setZoom(targetZoom - 0.05);
        }}
        onFit={resetTransform}
        onFlyoutOpen={() => setBrushPanelOpen(false)}
        shapeKind={shapeKind}
        shapeFill={shapeFill}
        onShapePick={(kind) => {
          setShapeKind(kind);
          setPaintTool("shape");
          setSizeBarOpen(true);
        }}
        onShapeFillChange={setShapeFill}
      />

        {/* The brush panel carries its own size slider; this bar is for the pencil and eraser, and for the brush while its panel is shut. */}
        {sizeBarOpen &&
          (activeTool === "pencil" ||
          activeTool === "eraser" ||
          (activeTool === "brush" && !brushPanelVisible)) && (
          <div ref={sizeBarRef} className="absolute z-50 flex h-10 items-center gap-3 rounded-panel border border-line bg-panel px-3 text-[13px] text-ink shadow-rail" style={{ left: 76, top: 52 }}>
            <span className="text-ink-2">Size</span>
            <input
              type="range"
              min={activeTool === "brush" ? brushSpecNow.minSize : 0}
              max={activeTool === "brush" ? brushSpecNow.maxSize : 1000}
              step={activeTool === "brush" ? sizeStep(brushSpecNow) : "any"}
              value={activeTool === "brush" ? brushNow.size : sizeToSlider(brushSize)}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (activeTool === "brush") {
                  setBrushPrefs((m) => ({ ...m, [brushId]: { ...m[brushId], size: v } }));
                } else {
                  setBrushSize(sliderToSize(v));
                }
              }}
              aria-label="Brush size"
              className="w-28"
        style={rangeFill(activeTool === "brush" ? brushNow.size : sizeToSlider(brushSize), activeTool === "brush" ? brushSpecNow.minSize : 0, activeTool === "brush" ? brushSpecNow.maxSize : 1000)}
      />
            <span className="w-9 text-right font-mono">
              {formatSize(activeTool === "brush" ? brushNow.size : brushSize)}
            </span>
          </div>
        )}

        {/* Outline width for shapes (a solid shape has no outline to size). */}
        {sizeBarOpen && activeTool === "shape" && !(shapeFill && shapeKind !== "line" && shapeKind !== "arrow") && (
          <div ref={sizeBarRef} className="absolute z-50 flex h-10 items-center gap-3 rounded-panel border border-line bg-panel px-3 text-[13px] text-ink shadow-rail" style={{ left: 76, top: 52 }}>
            <span className="text-ink-2">Line width</span>
            <input
              type="range"
              min={1}
              max={40}
              step={1}
              value={shapeWidth}
              onChange={(e) => setShapeWidth(Number(e.target.value))}
              aria-label="Shape line width"
              className="w-28"
              style={rangeFill(shapeWidth, 1, 40)}
            />
            <span className="w-9 text-right font-mono">{shapeWidth}</span>
          </div>
        )}

        <div className="absolute z-50 flex gap-0.5 rounded-panel border border-line bg-panel p-1.5 shadow-rail" style={{ right: 20, bottom: 20 }}>
          <button
            onClick={() => setAlignMode(!alignMode)}
            className={`flex h-9 w-9 items-center justify-center rounded-tool ${
              alignMode ? "selected text-icon-on" : "text-icon hoverable"
            }`}
            title="Alignment mode"
            aria-label="Alignment mode"
          >
            <Crosshair size={17} />
          </button>

          <button
            onClick={() => {
              if (!lassoAvailable) return;
              setLassoMode(!lassoMode);
              setPoints([]);
              setIsDrawing(false);
            }}
            disabled={!lassoAvailable}
            aria-label="Lasso"
            title={
              lassoAvailable
                ? "Lasso"
                : isFlatDocument(editFrame)
                  ? "Reset position, zoom and rotation to use the lasso"
                  : "Flatten to a single layer to use the lasso"
            }
            className={`flex h-9 w-9 items-center justify-center rounded-tool ${
              !lassoAvailable
                ? "cursor-not-allowed text-icon opacity-30"
                : lassoMode
                  ? "selected text-icon-on"
                  : "text-icon hoverable"
            }`}
          >
            <PenTool size={17} />
          </button>

          {lassoMode && (
            <>
              <button
                onClick={createSelection}
                disabled={points.length < 3}
                title="Make selection from lasso"
                aria-label="Make selection from lasso"
                className="flex h-9 w-9 items-center justify-center rounded-tool bg-primary text-on-primary hoverable disabled:opacity-40"
              >
                <Check size={18} />
              </button>

              <button
                onClick={() => setPoints((p) => p.slice(0, -1))}
                title="Remove last lasso point"
                aria-label="Remove last lasso point"
                className="flex h-9 w-9 items-center justify-center rounded-tool text-icon hoverable"
              >
                <Undo2 size={18} />
              </button>

              <button
                onClick={() => {
                  setPoints([]);
                  setLassoMode(false);
                  setIsDrawing(false);
                }}
                title="Cancel lasso"
                aria-label="Cancel lasso"
                className="flex h-9 w-9 items-center justify-center rounded-tool border border-danger-line bg-danger-bg text-danger-strong hoverable"
              >
                <X size={18} />
              </button>
            </>
          )}

          {selectionActive && (
            <>
              <button
                onClick={applySelection}
                className="flex h-9 w-9 items-center justify-center rounded-tool bg-primary text-on-primary hoverable"
                title="Apply selection (Enter)"
                aria-label="Apply selection"
              >
                <Check size={18} />
              </button>
              <button
                onClick={cancelSelection}
                className="flex h-9 w-9 items-center justify-center rounded-tool border border-danger-line bg-danger-bg text-danger-strong hoverable"
                title="Cancel selection (Esc)"
                aria-label="Cancel selection"
              >
                <X size={18} />
              </button>
            </>
          )}
        </div>

        {/* Precision controls */}
        {alignMode && (
          <div className="absolute z-50 w-48 space-y-3 rounded-panel border border-line bg-panel p-4 shadow-rail" style={{ right: 20, bottom: 76 }}>
            <div className="section-title">
              Alignment
            </div>

            <div className="flex items-center justify-between text-xs text-ink">
              <span>X</span>
              <div className="flex items-center gap-2">
                <span className="w-8 text-center font-mono">
                  {targetLayer ? Math.round(targetLayer.pose.position.x) : 0}
                </span>
                <div className="flex gap-1">
                  <button
                    disabled={transformsLocked}
                    onClick={() => nudge(-1, 0)}
                    className="flex h-6 w-6 items-center justify-center rounded-ctrl bg-ctrl hoverable disabled:opacity-40"
                  >
                    –
                  </button>
                  <button
                    disabled={transformsLocked}
                    onClick={() => nudge(1, 0)}
                    className="flex h-6 w-6 items-center justify-center rounded-ctrl bg-ctrl hoverable disabled:opacity-40"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between text-xs text-ink">
              <span>Y</span>
              <div className="flex items-center gap-2">
                <span className="w-8 text-center font-mono">
                  {targetLayer ? Math.round(targetLayer.pose.position.y) : 0}
                </span>
                <div className="flex gap-1">
                  <button
                    disabled={transformsLocked}
                    onClick={() => nudge(0, -1)}
                    className="flex h-6 w-6 items-center justify-center rounded-ctrl bg-ctrl hoverable disabled:opacity-40"
                  >
                    –
                  </button>
                  <button
                    disabled={transformsLocked}
                    onClick={() => nudge(0, 1)}
                    className="flex h-6 w-6 items-center justify-center rounded-ctrl bg-ctrl hoverable disabled:opacity-40"
                  >
                    +
                  </button>
                </div>
              </div>
            </div>

            {/* View rotation is a viewing aid, not frame state — so not undoable. */}
            <div className="flex items-center justify-between text-xs text-ink">
              <span title="View rotation (not saved to the frame)">↻</span>
              <div className="flex gap-1">
                <button
                  disabled={transformsLocked}
                  onClick={() =>
                    onViewChange({
                      ...view,
                      rotation: +(view.rotation - 0.5).toFixed(1),
                    })
                  }
                  className="h-6 w-6 rounded-ctrl bg-ctrl hoverable disabled:opacity-40"
                >
                  –
                </button>
                <button
                  disabled={transformsLocked}
                  onClick={() =>
                    onViewChange({
                      ...view,
                      rotation: +(view.rotation + 0.5).toFixed(1),
                    })
                  }
                  className="h-6 w-6 rounded-ctrl bg-ctrl hoverable disabled:opacity-40"
                >
                  +
                </button>
              </div>
            </div>

            <button
              disabled={transformsLocked}
              onClick={() => {
                commitHistory();
                onViewChange({ x: 0, y: 0, rotation: 0 });
                // Centres the SELECTION as a rigid group, preserving each
                // layer's relative offset — not by setting every position to
                // the canvas centre, which would collapse a multi-layer
                // arrangement into a pile.
                editor.dispatch({
                  type: "xf/center",
                  selection:
                    editor.selection.ids.length > 0
                      ? editor.selection
                      : baseSelection,
                });
              }}
              className="mt-1 h-8 w-full rounded-ctrl bg-primary hoverable text-xs font-medium text-on-primary disabled:opacity-40"
            >
              Center
            </button>
          </div>
        )}

      {/* The panel lives outside the frame because the frame clips its children. */}
      {brushPanelVisible && (
        <div
          ref={brushPanelRef}
          className="absolute z-[60] flex max-h-[calc(100%-24px)]"
          style={{ left: brushPanelPos.left, top: brushPanelPos.top }}
        >
          <BrushPanel
            brushId={brushId}
            prefs={brushPrefs}
            color={paintColor}
            onSelect={setBrushId}
            onChange={(id, patch) =>
              setBrushPrefs((m) => ({ ...m, [id]: { ...m[id], ...patch } }))
            }
            onClose={() => setBrushPanelOpen(false)}
          />
        </div>
      )}
    </section>
  );
}