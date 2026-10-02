"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { gridFromCuts, type SpriteGrid } from "@/lib/sprite";
import { extractCleanCells } from "@/lib/sprite/slice";
import { cutter } from "@/styles/tokens";

/* ═══════════════════════════════════════════════════════════════════════════
 * MATHEMATICS
 *
 * Self-contained, integer-exact, allocation-free after warm-up. This mirrors
 * the engine's occupancy → profile → Otsu → gap pipeline, but it is used ONLY
 * to answer questions the user explicitly asks ("where are the gutters?",
 * "rule me a 4×6"). Nothing here ever mutates the cut vectors on its own.
 * ═══════════════════════════════════════════════════════════════════════════ */

const MAX_L1 = 765;
const OTSU_BINS = 256;

/** Occupancy in Q8: 0 = certainly background, 255 = certainly content. */
type Occupancy = {
  readonly data: Uint8Array;
  readonly kind: "alpha" | "background" | "saturated";
};

/**
 * Case A: meaningful alpha → occupancy IS alpha (encoder ground truth).
 * Case B: opaque + uniform border → ramped L1 distance from the border mode.
 * Case C: neither → saturated. A constant field has a constant profile, hence
 *         no gaps, hence the snap tools correctly report "nothing to snap to"
 *         rather than inventing gutters in a photograph.
 */
function buildOccupancy(img: ImageData): Occupancy {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const out = new Uint8Array(n);

  let transparent = 0;
  let translucent = 0;
  for (let p = 0, i = 3; p < n; p++, i += 4) {
    const a = data[i];
    if (a === 0) transparent++;
    else if (a !== 255) translucent++;
  }
  // 0.5% fully transparent, or 5% translucent, is a mask rather than an artefact.
  if (transparent * 1000 >= n * 5 || translucent * 1000 >= n * 50) {
    for (let p = 0, i = 3; p < n; p++, i += 4) out[p] = data[i];
    return { data: out, kind: "alpha" };
  }

  // Border frame, inset by 2 px so a drawn bounding box cannot be mistaken
  // for the background.
  const inset = 2;
  const x0 = inset < w / 2 ? inset : 0;
  const x1 = w - 1 - x0;
  const y0 = inset < h / 2 ? inset : 0;
  const y1 = h - 1 - y0;
  if (x1 <= x0 || y1 <= y0) return saturate(out);

  // 5 bits/channel histogram of the border.
  const LV = 32;
  const hist = new Int32Array(LV * LV * LV);
  const sR = new Int32Array(hist.length);
  const sG = new Int32Array(hist.length);
  const sB = new Int32Array(hist.length);
  let count = 0;

  const visit = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const bin = ((r >> 3) * LV + (g >> 3)) * LV + (b >> 3);
    hist[bin]++; sR[bin] += r; sG[bin] += g; sB[bin] += b; count++;
  };
  for (let x = x0; x <= x1; x++) { visit(x, y0); visit(x, y1); }
  for (let y = y0 + 1; y < y1; y++) { visit(x0, y); visit(x1, y); }

  let mode = 0;
  for (let bin = 1; bin < hist.length; bin++) if (hist[bin] > hist[mode]) mode = bin;

  // Agreement over the modal bin and its 26 quantised neighbours.
  const mb = mode % LV;
  const mg = ((mode / LV) | 0) % LV;
  const mr = (mode / (LV * LV)) | 0;
  let agree = 0;
  for (let dr = -1; dr <= 1; dr++) {
    const rr = mr + dr; if (rr < 0 || rr >= LV) continue;
    for (let dg = -1; dg <= 1; dg++) {
      const gg = mg + dg; if (gg < 0 || gg >= LV) continue;
      for (let db = -1; db <= 1; db++) {
        const bq = mb + db; if (bq < 0 || bq >= LV) continue;
        agree += hist[(rr * LV + gg) * LV + bq];
      }
    }
  }
  if (agree * 1000 < count * 900) return saturate(out); // not separable

  const c = hist[mode];
  const br = (sR[mode] / c) | 0, bg = (sG[mode] / c) | 0, bb = (sB[mode] / c) | 0;

  // Noise floor = median + 3·MAD of border distance about the mode. Measured,
  // not tuned, so a JPEG's ringing contributes exactly zero mass.
  const dh = new Int32Array(MAX_L1 + 1);
  const collect = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    dh[Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb)]++;
  };
  for (let x = x0; x <= x1; x++) { collect(x, y0); collect(x, y1); }
  for (let y = y0 + 1; y < y1; y++) { collect(x0, y); collect(x1, y); }

  const med = medianOf(dh, count);
  const devh = new Int32Array(MAX_L1 + 1);
  for (let d = 0; d <= MAX_L1; d++) if (dh[d]) devh[Math.abs(d - med)] += dh[d];
  const floor = Math.min(MAX_L1 - 1, med + 3 * medianOf(devh, count) + 1);

  // Full-image distance histogram → 90th percentile of the FOREGROUND tail as
  // the saturation point. A whole-image percentile would sit inside the noise
  // floor (85–95% of a sheet is background) and blow every sprite to white.
  const dist = new Uint16Array(n);
  const fh = new Int32Array(MAX_L1 + 1);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const d = Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb);
    dist[p] = d; fh[d]++;
  }
  let tail = 0;
  for (let v = floor + 1; v <= MAX_L1; v++) tail += fh[v];
  let scale = floor + 1;
  if (tail > 0) {
    const target = Math.ceil((tail * 900) / 1000);
    let cum = 0;
    for (let v = floor + 1; v <= MAX_L1; v++) {
      cum += fh[v];
      if (cum >= target) { scale = v; break; }
    }
  }

  // Piecewise-linear ramp with a dead zone: antialiasing keeps its partial
  // occupancy, compression noise keeps none.
  const span = Math.max(1, scale - floor);
  const ramp = new Uint8Array(MAX_L1 + 1);
  for (let d = floor + 1; d <= MAX_L1; d++) {
    const v = (((d - floor) * 255) / span) | 0;
    ramp[d] = v >= 255 ? 255 : v;
  }
  for (let p = 0, i = 3; p < n; p++, i += 4) {
    const v = ramp[dist[p]];
    if (v === 0) continue;
    const a = data[i];
    out[p] = a === 255 ? v : ((v * a) / 255) | 0;
  }
  return { data: out, kind: "background" };
}

function saturate(out: Uint8Array): Occupancy {
  out.fill(255);
  return { data: out, kind: "saturated" };
}

function medianOf(hist: Int32Array, total: number): number {
  if (total <= 0) return 0;
  const target = Math.ceil(total / 2);
  let cum = 0;
  for (let v = 0; v < hist.length; v++) {
    cum += hist[v];
    if (cum >= target) return v;
  }
  return hist.length - 1;
}

/** Radius-1 box pass via prefix sums, mean-preserving at the borders. */
function boxSmooth(p: Uint32Array): Uint32Array {
  const n = p.length;
  const out = new Uint32Array(n);
  if (n === 0) return out;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + p[i];
  for (let i = 0; i < n; i++) {
    const lo = i > 0 ? i - 1 : 0;
    const hi = i + 2 > n ? n : i + 2;
    out[i] = Math.floor((pre[hi] - pre[lo]) / (hi - lo));
  }
  return out;
}

/** Integer Otsu, in profile units. Ties take the lowest boundary (conservative). */
function otsu(p: Uint32Array): number {
  const n = p.length;
  if (n === 0) return 0;
  let min = p[0], max = p[0];
  for (let i = 1; i < n; i++) { if (p[i] < min) min = p[i]; if (p[i] > max) max = p[i]; }
  if (max <= min) return min;

  const span = max - min;
  const hist = new Int32Array(OTSU_BINS);
  for (let i = 0; i < n; i++) {
    let b = Math.floor(((p[i] - min) * (OTSU_BINS - 1)) / span);
    if (b < 0) b = 0; else if (b >= OTSU_BINS) b = OTSU_BINS - 1;
    hist[b]++;
  }
  let total = 0;
  for (let b = 0; b < OTSU_BINS; b++) total += hist[b] * b;

  let bestNum = -1, bestDen = 1, bestBin = 0, cLow = 0, sLow = 0;
  for (let b = 0; b < OTSU_BINS - 1; b++) {
    cLow += hist[b]; sLow += hist[b] * b;
    const cHigh = n - cLow;
    if (cLow === 0 || cHigh === 0) continue;
    const delta = sLow * cHigh - (total - sLow) * cLow;
    const num = delta * delta;
    const den = cLow * cHigh;
    if (num * bestDen > bestNum * den) { bestNum = num; bestDen = den; bestBin = b; }
  }
  return min + Math.floor((bestBin * span) / (OTSU_BINS - 1));
}

type Gap = { start: number; end: number; center: number; width: number; border: boolean };

/** Maximal runs of profile[i] <= threshold. Interior runs only are separatrices. */
function extractGaps(p: Uint32Array, threshold: number): Gap[] {
  const n = p.length;
  const gaps: Gap[] = [];
  let start = -1;
  const close = (end: number) => {
    const width = end - start + 1;
    gaps.push({ start, end, center: start + ((width - 1) >> 1), width, border: start === 0 || end === n - 1 });
    start = -1;
  };
  for (let i = 0; i < n; i++) {
    if (p[i] <= threshold) { if (start < 0) start = i; }
    else if (start >= 0) close(i - 1);
  }
  if (start >= 0) close(n - 1);
  return gaps;
}

type Axis = "x" | "y";

/** Marginal projections + everything the snap tools read. Computed once. */
type AxisModel = {
  readonly profile: Uint32Array;   // smoothed, for display and snapping
  readonly raw: Uint32Array;
  readonly threshold: number;
  readonly gaps: readonly Gap[];
  readonly centers: readonly number[]; // interior gap centres, ascending
  readonly peak: number;
};

function buildAxisModel(occ: Uint8Array, w: number, h: number, axis: Axis): AxisModel {
  const len = axis === "x" ? w : h;
  const raw = new Uint32Array(len);
  if (axis === "x") {
    for (let y = 0; y < h; y++) {
      const base = y * w;
      for (let x = 0; x < w; x++) raw[x] += occ[base + x];
    }
  } else {
    for (let y = 0; y < h; y++) {
      const base = y * w;
      let s = 0;
      for (let x = 0; x < w; x++) s += occ[base + x];
      raw[y] = s;
    }
  }
  const profile = boxSmooth(raw);
  const threshold = otsu(profile);
  const gaps = extractGaps(profile, threshold);
  const centers = gaps.filter((g) => !g.border).map((g) => g.center);
  let peak = 1;
  for (let i = 0; i < len; i++) if (profile[i] > peak) peak = profile[i];
  return { profile, raw, threshold, gaps, centers, peak };
}

/**
 * Symmetric remainder placement — the engine's remainder theorem, applied by
 * hand. ρ = extent − k·⌊extent/k⌋ is split ⌊ρ/2⌋ low / ⌈ρ/2⌉ high, so an
 * indivisible sheet loses a symmetric sliver instead of a fat final column.
 * Returns the INTERIOR cuts only.
 */
function uniformCuts(extent: number, divisions: number): { cuts: number[]; origin: number; cell: number; remainder: number } {
  const k = Math.max(1, divisions);
  const cell = Math.floor(extent / k);
  const remainder = extent - k * cell;
  const origin = remainder >> 1;
  const cuts: number[] = [];
  for (let i = 1; i < k; i++) cuts.push(origin + i * cell);
  return { cuts, origin, cell, remainder };
}

/** Median absolute deviation of consecutive spacings. 0 ⇔ perfectly uniform. */
function spacingMad(bounds: readonly number[]): number {
  if (bounds.length < 3) return 0;
  const d: number[] = [];
  for (let i = 1; i < bounds.length; i++) d.push(bounds[i] - bounds[i - 1]);
  const med = median(d);
  return median(d.map((v) => Math.abs(v - med)));
}

function median(v: readonly number[]): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.floor((s[m - 1] + s[m]) / 2);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * CUT-VECTOR REDUCER — the single source of truth for geometry.
 *
 * Every mutation goes through here, every mutation is validated for strict
 * monotonicity and minimum cell size BEFORE it lands, and every mutation is
 * undoable. Illegal states are unrepresentable rather than merely unlikely.
 * ═══════════════════════════════════════════════════════════════════════════ */

const MIN_CELL = 2;
const HISTORY_LIMIT = 100;
const MAX_FRAMES = 1024;

type Cuts = { x: readonly number[]; y: readonly number[] };
type CutState = { present: Cuts; past: Cuts[]; future: Cuts[] };

type CutAction =
  | { type: "add"; axis: Axis; v: number; extent: number }
  | { type: "remove"; axis: Axis; index: number }
  | { type: "move"; axis: Axis; index: number; v: number; extent: number; commit: boolean }
  | { type: "set"; axis: Axis | "both"; x?: readonly number[]; y?: readonly number[] }
  | { type: "clear" }
  | { type: "undo" }
  | { type: "redo" };

/** Legal insertion positions only: interior, and MIN_CELL from every neighbour. */
function canInsert(list: readonly number[], v: number, extent: number): boolean {
  if (!Number.isInteger(v) || v < MIN_CELL || v > extent - MIN_CELL) return false;
  for (const c of list) if (Math.abs(c - v) < MIN_CELL) return false;
  return true;
}

/** Clamp a dragged cut strictly between its neighbours. Order is an invariant. */
function clampMove(list: readonly number[], index: number, v: number, extent: number): number {
  const lo = (index > 0 ? list[index - 1] : 0) + MIN_CELL;
  const hi = (index < list.length - 1 ? list[index + 1] : extent) - MIN_CELL;
  if (lo > hi) return list[index];
  return v < lo ? lo : v > hi ? hi : v;
}

function push(state: CutState, next: Cuts): CutState {
  return {
    present: next,
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    future: [],
  };
}

function cutsReducer(state: CutState, action: CutAction): CutState {
  const { present } = state;
  switch (action.type) {
    case "add": {
      const list = present[action.axis];
      if (!canInsert(list, action.v, action.extent)) return state;
      const next = [...list, action.v].sort((a, b) => a - b);
      return push(state, { ...present, [action.axis]: next });
    }
    case "remove": {
      const list = present[action.axis];
      if (action.index < 0 || action.index >= list.length) return state;
      return push(state, { ...present, [action.axis]: list.filter((_, i) => i !== action.index) });
    }
    case "move": {
      const list = present[action.axis];
      if (action.index < 0 || action.index >= list.length) return state;
      const v = clampMove(list, action.index, action.v, action.extent);
      if (v === list[action.index]) return state;
      const next = list.map((c, i) => (i === action.index ? v : c));
      // Only the gesture's first step records history; the rest coalesce.
      return action.commit
        ? push(state, { ...present, [action.axis]: next })
        : { ...state, present: { ...present, [action.axis]: next } };
    }
    case "set":
      return push(state, {
        x: action.x ?? present.x,
        y: action.y ?? present.y,
      });
    case "clear":
      if (present.x.length === 0 && present.y.length === 0) return state;
      return push(state, { x: [], y: [] });
    case "undo": {
      const prev = state.past[state.past.length - 1];
      if (!prev) return state;
      return { present: prev, past: state.past.slice(0, -1), future: [state.present, ...state.future] };
    }
    case "redo": {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return { present: next, past: [...state.past, state.present], future: rest };
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * COMPONENT
 * ═══════════════════════════════════════════════════════════════════════════ */

interface Props {
  source: Blob | ImageData;
  onCancel: () => void;
  onSliced: (grid: SpriteGrid, frames: string[]) => void;
}

const MAX_W = 820;
const MAX_H = 560;
const HIT_TOL = 7;      // screen px to grab a line
const SNAP_TOL = 24;    // image px: furthest a cut may be dragged to a gutter
const RULER = 22;       // px of chrome reserved for the profile strips
const PROFILE_H = 30;

type Tool = "move" | "addV" | "addH" | "del";

type Selection = { axis: Axis; index: number } | null;

export default function SpriteSheetCutter({ source, onCancel, onSliced }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sheetRef = useRef<HTMLCanvasElement | null>(null); // natural-size backing store

  const [img, setImg] = useState<ImageData | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(1);
  const [showProfiles, setShowProfiles] = useState(true);
  const [busy, setBusy] = useState<null | { done: number; total: number }>(null);
  const [error, setError] = useState<string | null>(null);
  /** Keep only each cell's own sprite; neighbour pieces and drawn lines become transparent. */
  const [cleanEdges, setCleanEdges] = useState(true);
  const [cleanNote, setCleanNote] = useState<string | null>(null);

  const [state, dispatch] = useReducer(cutsReducer, { present: { x: [], y: [] }, past: [], future: [] });
  const cutsX = state.present.x;
  const cutsY = state.present.y;

  const [tool, setTool] = useState<Tool>("move");
  const [selection, setSelection] = useState<Selection>(null);
  const [cols, setCols] = useState(4);
  const [rows, setRows] = useState(4);

  // Non-reactive gesture state, so pointermove never re-renders unless the
  // geometry actually changed.
  const drag = useRef<{ axis: Axis; index: number; started: boolean } | null>(null);
  const hover = useRef<{ x: number; y: number } | null>(null);
  const raf = useRef(0);

  const width = img?.width ?? 0;
  const height = img?.height ?? 0;
  const scale = fit * zoom;

  /* ── Decode the source once, at natural size ───────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    let bitmap: ImageBitmap | null = null;

    (async () => {
      try {
        let w: number, h: number;
        if (source instanceof ImageData) { w = source.width; h = source.height; }
        else {
          bitmap = await createImageBitmap(source);
          w = bitmap.width; h = bitmap.height;
        }
        if (!w || !h) throw new Error("Image has zero extent.");
        if (w * h > 64_000_000) throw new Error("Image exceeds 64 megapixels.");

        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("2D context unavailable.");
        if (source instanceof ImageData) ctx.putImageData(source, 0, 0);
        else if (bitmap) ctx.drawImage(bitmap, 0, 0);

        const data = ctx.getImageData(0, 0, w, h);
        if (cancelled) return;

        sheetRef.current = c;
        setImg(data);
        setFit(Math.min(MAX_W / w, MAX_H / h, 1));
        setZoom(1);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not read image.");
      } finally {
        bitmap?.close();
      }
    })();

    return () => { cancelled = true; };
  }, [source]);

  /* ── Occupancy + marginals: one O(WH) pass for the whole session ───────── */
  const model = useMemo(() => {
    if (!img) return null;
    const occ = buildOccupancy(img);
    return {
      kind: occ.kind,
      x: buildAxisModel(occ.data, img.width, img.height, "x"),
      y: buildAxisModel(occ.data, img.width, img.height, "y"),
    };
  }, [img]);

  const axisModel = useCallback(
    (axis: Axis) => (axis === "x" ? model?.x ?? null : model?.y ?? null),
    [model]
  );

  /* ── Derived geometry ──────────────────────────────────────────────────── */
  const boundsX = useMemo(() => [0, ...cutsX, width], [cutsX, width]);
  const boundsY = useMemo(() => [0, ...cutsY, height], [cutsY, height]);
  const frameCount = (cutsX.length + 1) * (cutsY.length + 1);

  const report = useMemo(() => {
    const cw: number[] = [], ch: number[] = [];
    for (let i = 1; i < boundsX.length; i++) cw.push(boundsX[i] - boundsX[i - 1]);
    for (let i = 1; i < boundsY.length; i++) ch.push(boundsY[i] - boundsY[i - 1]);
    const minCell = Math.min(...cw, ...ch);
    const madX = spacingMad(boundsX);
    const madY = spacingMad(boundsY);

    // Do the cut lines actually sit in gutters? Reported, never enforced.
    const onGutter = (axis: Axis, cuts: readonly number[]) => {
      const m = axisModel(axis);
      if (!m || cuts.length === 0) return null;
      let clean = 0;
      for (const c of cuts) {
        let best = Infinity;
        for (let d = -2; d <= 2; d++) {
          const i = c + d;
          if (i >= 0 && i < m.profile.length && m.profile[i] < best) best = m.profile[i];
        }
        if (best <= m.threshold) clean++;
      }
      return { clean, total: cuts.length };
    };

    return {
      widths: cw,
      heights: ch,
      minCell,
      uniform: madX === 0 && madY === 0,
      madX,
      madY,
      modalW: median(cw),
      modalH: median(ch),
      seamX: onGutter("x", cutsX),
      seamY: onGutter("y", cutsY),
    };
  }, [boundsX, boundsY, cutsX, cutsY, axisModel]);

  const valid =
    !!img &&
    frameCount >= 2 &&
    frameCount <= MAX_FRAMES &&
    report.minCell >= MIN_CELL;

  /* ── Coordinate mapping: measured from the live rect, never assumed ────── */
  const toImage = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !img) return null;
    const r = canvas.getBoundingClientRect();
    const sx = img.width / Math.max(1, r.width - RULER);
    const sy = img.height / Math.max(1, r.height - RULER);
    return {
      x: Math.round((clientX - r.left - RULER) * sx),
      y: Math.round((clientY - r.top - RULER) * sy),
      inside:
        clientX >= r.left + RULER && clientX <= r.right &&
        clientY >= r.top + RULER && clientY <= r.bottom,
      px: sx, py: sy,
    };
  }, [img]);

  /** Nearest cut on either axis within HIT_TOL screen px. Closest wins. */
  const pick = useCallback((x: number, y: number): Selection => {
    let best: Selection = null;
    let bestD = Infinity;
    cutsX.forEach((c, i) => {
      const d = Math.abs(c - x) * scale;
      if (d <= HIT_TOL && d < bestD) { bestD = d; best = { axis: "x", index: i }; }
    });
    cutsY.forEach((c, i) => {
      const d = Math.abs(c - y) * scale;
      if (d <= HIT_TOL && d < bestD) { bestD = d; best = { axis: "y", index: i }; }
    });
    return best;
  }, [cutsX, cutsY, scale]);

  /* ── Pointer handling ──────────────────────────────────────────────────── */
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toImage(e.clientX, e.clientY);
    if (!p || !p.inside || !img) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (tool === "addV") { dispatch({ type: "add", axis: "x", v: p.x, extent: img.width }); return; }
    if (tool === "addH") { dispatch({ type: "add", axis: "y", v: p.y, extent: img.height }); return; }

    const hit = pick(p.x, p.y);
    if (!hit) { setSelection(null); return; }

    if (tool === "del") { dispatch({ type: "remove", axis: hit.axis, index: hit.index }); setSelection(null); return; }

    setSelection(hit);
    drag.current = { ...hit, started: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const p = toImage(e.clientX, e.clientY);
    hover.current = p && p.inside ? { x: p.x, y: p.y } : null;

    const d = drag.current;
    if (d && img) {
      const v = d.axis === "x" ? p?.x : p?.y;
      if (typeof v === "number") {
        dispatch({
          type: "move",
          axis: d.axis,
          index: d.index,
          v,
          extent: d.axis === "x" ? img.width : img.height,
          commit: !d.started,
        });
        d.started = true;
      }
    } else {
      schedule(); // cheap: repaint the hover guide without touching React state
    }
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const onPointerLeave = () => { hover.current = null; schedule(); };

  /* ── Keyboard: nudge, snap, delete, undo ───────────────────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (!img) return;

      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); onCancel(); return; }

      if (!selection) return;
      const list = selection.axis === "x" ? cutsX : cutsY;
      const extent = selection.axis === "x" ? img.width : img.height;

      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        dispatch({ type: "remove", axis: selection.axis, index: selection.index });
        setSelection(null);
        return;
      }

      const step = e.shiftKey ? 8 : 1;
      const dir =
        e.key === "ArrowLeft" || e.key === "ArrowUp" ? -step :
        e.key === "ArrowRight" || e.key === "ArrowDown" ? step : 0;
      if (dir === 0) return;

      const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
      if ((selection.axis === "x") !== horizontal) return;

      e.preventDefault();
      dispatch({ type: "move", axis: selection.axis, index: selection.index, v: list[selection.index] + dir, extent, commit: true });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, cutsX, cutsY, img, onCancel]);

  /* ── Manual mathematical actions ───────────────────────────────────────── */

  /** Rule a uniform cols×rows grid with symmetric remainder cropping. */
  const applyUniform = () => {
    if (!img) return;
    const c = Math.max(1, Math.min(64, Math.floor(cols) || 1));
    const r = Math.max(1, Math.min(64, Math.floor(rows) || 1));
    dispatch({
      type: "set",
      axis: "both",
      x: uniformCuts(img.width, c).cuts,
      y: uniformCuts(img.height, r).cuts,
    });
    setSelection(null);
  };

  /**
   * Pull each existing cut to the nearest interior gutter centre, at most
   * SNAP_TOL px, never past a neighbour, never onto an already-claimed gutter.
   * This does not add or remove a single line — it only sharpens the user's
   * own ruling against measured evidence.
   */
  const snapAll = () => {
    if (!img || !model) return;
    const run = (axis: Axis, list: readonly number[], extent: number) => {
      const centers = axisModel(axis)?.centers ?? [];
      if (centers.length === 0) return [...list];
      const taken = new Set<number>();
      const out = [...list];
      // Greedy in order of confidence: the closest pairing is assigned first,
      // so one gutter cannot swallow two cuts.
      const order = list
        .map((v, i) => ({ i, v, d: Math.min(...centers.map((c) => Math.abs(c - v))) }))
        .sort((a, b) => a.d - b.d);
      for (const { i, v } of order) {
        let best = -1, bestD = Infinity;
        for (const c of centers) {
          if (taken.has(c)) continue;
          const d = Math.abs(c - v);
          if (d <= SNAP_TOL && d < bestD) { bestD = d; best = c; }
        }
        if (best < 0) continue;
        const lo = (i > 0 ? out[i - 1] : 0) + MIN_CELL;
        const hi = (i < out.length - 1 ? out[i + 1] : extent) - MIN_CELL;
        if (best < lo || best > hi) continue;
        out[i] = best;
        taken.add(best);
      }
      return out;
    };
    dispatch({
      type: "set",
      axis: "both",
      x: run("x", cutsX, img.width),
      y: run("y", cutsY, img.height),
    });
  };

  /** Place one line per detected interior gutter on the given axis. */
  const ruleFromGutters = (axis: Axis) => {
    if (!img) return;
    const centers = axisModel(axis)?.centers ?? [];
    const extent = axis === "x" ? img.width : img.height;
    const out: number[] = [];
    for (const c of centers) {
      if (c < MIN_CELL || c > extent - MIN_CELL) continue;
      if (out.length && c - out[out.length - 1] < MIN_CELL) continue;
      out.push(c);
    }
    dispatch({ type: "set", axis, [axis]: out } as CutAction);
    setSelection(null);
  };

  const gutterCount = (axis: Axis) => axisModel(axis)?.centers.length ?? 0;

  /* ── Rendering: hi-DPI, crisp, rAF-coalesced ───────────────────────────── */
  const schedule = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => { raf.current = 0; paint(); });
  }, []); // paint reads refs/latest closure via the effect below

  const paintRef = useRef<() => void>(() => {});
  const paint = () => paintRef.current();

  useEffect(() => {
    paintRef.current = () => {
      const canvas = canvasRef.current;
      const sheet = sheetRef.current;
      if (!canvas || !sheet || !img) return;

      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const cssW = Math.round(img.width * scale) + RULER;
      const cssH = Math.round(img.height * scale) + RULER;

      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const w = img.width * scale;
      const h = img.height * scale;

      // Checkerboard, so transparent gutters are visible as gutters.
      ctx.save();
      ctx.translate(RULER, RULER);
      const q = 8;
      for (let y = 0; y < h; y += q) {
        for (let x = 0; x < w; x += q) {
          ctx.fillStyle = ((x / q + y / q) & 1) ? cutter.checkerA : cutter.checkerB;
          ctx.fillRect(x, y, Math.min(q, w - x), Math.min(q, h - y));
        }
      }

      // The sheet. Nearest-neighbour when magnifying: this is pixel work.
      ctx.imageSmoothingEnabled = scale < 1;
      ctx.drawImage(sheet, 0, 0, img.width, img.height, 0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.restore();

      // Marginal profiles in the ruler gutters — the evidence, drawn where the
      // user is already looking.
      if (showProfiles && model) {
        const px = model.x, py = model.y;
        ctx.save();
        ctx.translate(RULER, 0);
        ctx.fillStyle = cutter.profile;
        ctx.beginPath();
        ctx.moveTo(0, RULER);
        for (let i = 0; i < px.profile.length; i++) {
          const v = (px.profile[i] / px.peak) * (PROFILE_H - 4);
          ctx.lineTo(i * scale, RULER - Math.min(RULER - 1, v));
        }
        ctx.lineTo(w, RULER);
        ctx.closePath();
        ctx.fill();
        // Otsu level: below this line is a gutter.
        const tx = RULER - Math.min(RULER - 1, (px.threshold / px.peak) * (PROFILE_H - 4));
        ctx.strokeStyle = cutter.profileLine;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(0, tx + 0.5); ctx.lineTo(w, tx + 0.5); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        ctx.save();
        ctx.translate(0, RULER);
        ctx.fillStyle = cutter.profile;
        ctx.beginPath();
        ctx.moveTo(RULER, 0);
        for (let i = 0; i < py.profile.length; i++) {
          const v = (py.profile[i] / py.peak) * (PROFILE_H - 4);
          ctx.lineTo(RULER - Math.min(RULER - 1, v), i * scale);
        }
        ctx.lineTo(RULER, h);
        ctx.closePath();
        ctx.fill();
        const ty = RULER - Math.min(RULER - 1, (py.threshold / py.peak) * (PROFILE_H - 4));
        ctx.strokeStyle = cutter.profileLine;
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(ty + 0.5, 0); ctx.lineTo(ty + 0.5, h); ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // Detected gutter centres as faint ticks: targets, not decisions.
        ctx.strokeStyle = cutter.centers;
        ctx.setLineDash([2, 6]);
        ctx.beginPath();
        for (const c of px.centers) {
          const X = RULER + c * scale + 0.5;
          ctx.moveTo(X, RULER); ctx.lineTo(X, RULER + h);
        }
        for (const c of py.centers) {
          const Y = RULER + c * scale + 0.5;
          ctx.moveTo(RULER, Y); ctx.lineTo(RULER + w, Y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Cut lines. Half-pixel offsets keep 1-px strokes from straddling.
      const drawCut = (axis: Axis, v: number, active: boolean) => {
        const p = RULER + v * scale + 0.5;
        ctx.lineWidth = active ? 2 : 1;
        ctx.strokeStyle = active ? cutter.cutActive : cutter.cut;
        ctx.beginPath();
        if (axis === "x") { ctx.moveTo(p, RULER); ctx.lineTo(p, RULER + h); }
        else { ctx.moveTo(RULER, p); ctx.lineTo(RULER + w, p); }
        ctx.stroke();
      };
      cutsX.forEach((c, i) => drawCut("x", c, selection?.axis === "x" && selection.index === i));
      cutsY.forEach((c, i) => drawCut("y", c, selection?.axis === "y" && selection.index === i));

      // Cell extents, centred in each span. Suppressed when they would collide.
      ctx.font = "10px ui-monospace, monospace";
      ctx.textBaseline = "middle";
      ctx.fillStyle = cutter.labelX;
      ctx.textAlign = "center";
      for (let i = 1; i < boundsX.length; i++) {
        const span = (boundsX[i] - boundsX[i - 1]) * scale;
        if (span < 22) continue;
        ctx.fillText(String(boundsX[i] - boundsX[i - 1]), RULER + ((boundsX[i - 1] + boundsX[i]) / 2) * scale, RULER - PROFILE_H / 2 + 8);
      }
      ctx.fillStyle = cutter.labelY;
      ctx.textAlign = "center";
      for (let i = 1; i < boundsY.length; i++) {
        const span = (boundsY[i] - boundsY[i - 1]) * scale;
        if (span < 14) continue;
        ctx.save();
        const Y = RULER + ((boundsY[i - 1] + boundsY[i]) / 2) * scale;
        ctx.translate(RULER / 2, Y);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(String(boundsY[i] - boundsY[i - 1]), 0, 0);
        ctx.restore();
      }

      // Hover guide for the add tools, with a live snap preview.
      const hv = hover.current;
      if (hv && (tool === "addV" || tool === "addH")) {
        const axis: Axis = tool === "addV" ? "x" : "y";
        const v = axis === "x" ? hv.x : hv.y;
        const centers = axisModel(axis)?.centers ?? [];
        let near = -1, nd = Infinity;
        for (const c of centers) { const d = Math.abs(c - v); if (d <= SNAP_TOL && d < nd) { nd = d; near = c; } }

        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = cutter.hover;
        const p = RULER + v * scale + 0.5;
        ctx.beginPath();
        if (axis === "x") { ctx.moveTo(p, RULER); ctx.lineTo(p, RULER + h); }
        else { ctx.moveTo(RULER, p); ctx.lineTo(RULER + w, p); }
        ctx.stroke();

        if (near >= 0) {
          ctx.strokeStyle = cutter.snap;
          ctx.lineWidth = 2;
          const q2 = RULER + near * scale + 0.5;
          ctx.beginPath();
          if (axis === "x") { ctx.moveTo(q2, RULER); ctx.lineTo(q2, RULER + h); }
          else { ctx.moveTo(RULER, q2); ctx.lineTo(RULER + w, q2); }
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
    };
    paint();
  }, [img, model, scale, cutsX, cutsY, boundsX, boundsY, selection, tool, showProfiles, axisModel]);

  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);

  /* ── Slicing: sequential, bounded, cancellable, progress-reporting ─────── */
  const handleApply = async () => {
    const sheet = sheetRef.current;
    if (!img || !sheet || !valid) return;

    const grid = gridFromCuts(boundsX, boundsY);
    const total = frameCount;
    setBusy({ done: 0, total });

    // One scratch canvas, resized per cell. Never one canvas per frame.
    const scratch = document.createElement("canvas");
    const sctx = scratch.getContext("2d");
    if (!sctx) { setBusy(null); setError("2D context unavailable."); return; }

    const frames: string[] = [];
    try {
      // Clean pass: one analysis of the whole sheet, then per-cell ownership.
      // Falls back to plain rectangles when the background can't be separated.
      let cleaned: ImageData[] | null = null;
      setCleanNote(null);
      if (cleanEdges) {
        await new Promise((r2) => setTimeout(r2, 0)); // let "Encoding 0/n" paint first
        try {
          const result = extractCleanCells(img, grid);
          if (result.cleaned) cleaned = result.frames;
          else setCleanNote("Background couldn't be separated (photo or painted checkerboard) — frames were cut as plain rectangles.");
        } catch (err) {
          console.error("Clean cut failed, using plain rectangles", err);
          setCleanNote("Edge cleaning failed on this sheet — frames were cut as plain rectangles.");
        }
      }

      let k = 0;
      for (let r = 0; r < boundsY.length - 1; r++) {
        for (let c = 0; c < boundsX.length - 1; c++, k++) {
          const x = boundsX[c], y = boundsY[r];
          const cw = boundsX[c + 1] - x, chh = boundsY[r + 1] - y;

          scratch.width = cw; scratch.height = chh;
          sctx.clearRect(0, 0, cw, chh);
                    if (cleaned) {
            // Skip cells with (almost) no sprite in them: stray thin rows/cols.
            let ink = 0;
            const px = cleaned[k].data;
            for (let i = 3; i < px.length; i += 4) if (px[i] > 20) ink++;
            if (ink < 50) { setBusy({ done: frames.length, total }); continue; }
            sctx.putImageData(cleaned[k], 0, 0);
          } else {
            // Integer source rect from the natural-size backing store: source
            // pixels are copied, never resampled.
            sctx.drawImage(sheet, x, y, cw, chh, 0, 0, cw, chh);
          }

          const blob = await new Promise<Blob | null>((res) => scratch.toBlob(res, "image/png"));
          if (!blob) throw new Error(`Frame ${frames.length} failed to encode.`);
          frames.push(await blobToDataUrl(blob));

          setBusy({ done: frames.length, total });
          if ((frames.length & 15) === 0) await new Promise((r2) => setTimeout(r2, 0)); // yield
        }
      }
      onSliced(grid, frames);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Slicing failed.");
    } finally {
      setBusy(null);
    }
  };

  /* ── UI ────────────────────────────────────────────────────────────────── */
  const cursor =
    tool === "addV" ? "col-resize" :
    tool === "addH" ? "row-resize" :
    tool === "del" ? "not-allowed" : "default";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4">
      <div className="flex max-h-[96vh] w-full max-w-6xl flex-col overflow-hidden rounded-panel bg-panel text-ink shadow-flyout">
        {/* header */}
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            <h2 className="text-lg font-semibold">Adjust Grid &amp; Cut</h2>
            <p className="text-xs text-ink-3">
              {img ? `${img.width} × ${img.height} px` : "…"}
              {model && <> · occupancy: <span className="text-ink-2">{model.kind}</span></>}
              {model && <> · gutters: {gutterCount("x")}↕ / {gutterCount("y")}↔</>}
            </p>
          </div>
          <button onClick={onCancel} className="rounded-ctrl px-2 text-ink-2 hover:text-ink" aria-label="Close">✕</button>
        </div>

        {/* toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2 text-sm">
          {([["move", "Move"], ["addV", "＋ Vertical"], ["addH", "＋ Horizontal"], ["del", "Delete"]] as const).map(
            ([key, label]) => (
              <button
                key={key}
                onClick={() => setTool(key)}
                className={`rounded-ctrl px-3 py-1 ${tool === key ? "selected text-icon-on" : "bg-ctrl hoverable"}`}
              >
                {label}
              </button>
            )
          )}

          <span className="mx-1 h-5 w-px bg-ctrl-hi" />

          <div className="flex items-center gap-1">
            <input
              type="number" min={1} max={64} value={cols}
              onChange={(e) => setCols(Number(e.target.value))}
              className="w-14 rounded-ctrl bg-ctrl px-2 py-1 text-center font-mono outline-none focus:ring-1 focus:ring-accent"
              aria-label="Columns"
            />
            <span className="text-ink-3">×</span>
            <input
              type="number" min={1} max={64} value={rows}
              onChange={(e) => setRows(Number(e.target.value))}
              className="w-14 rounded-ctrl bg-ctrl px-2 py-1 text-center font-mono outline-none focus:ring-1 focus:ring-accent"
              aria-label="Rows"
            />
            <button onClick={applyUniform} className="rounded-ctrl bg-ctrl px-3 py-1 hoverable" title="Rule a uniform grid; any indivisible remainder is cropped symmetrically">
              Rule uniform
            </button>
          </div>

          <span className="mx-1 h-5 w-px bg-ctrl-hi" />

          <button onClick={snapAll} disabled={cutsX.length + cutsY.length === 0}
            className="rounded-ctrl bg-ctrl px-3 py-1 hoverable disabled:opacity-40"
            title="Pull each line to the nearest detected gutter centre (≤24 px)">
            Snap to gutters
          </button>
          <button onClick={() => ruleFromGutters("x")} disabled={gutterCount("x") === 0}
            className="rounded-ctrl bg-ctrl px-3 py-1 hoverable disabled:opacity-40"
            title="One vertical line per detected gutter">
            Rule cols ({gutterCount("x")})
          </button>
          <button onClick={() => ruleFromGutters("y")} disabled={gutterCount("y") === 0}
            className="rounded-ctrl bg-ctrl px-3 py-1 hoverable disabled:opacity-40"
            title="One horizontal line per detected gutter">
            Rule rows ({gutterCount("y")})
          </button>

          <span className="mx-1 h-5 w-px bg-ctrl-hi" />

          <button onClick={() => dispatch({ type: "undo" })} disabled={state.past.length === 0}
            className="rounded-ctrl bg-ctrl px-2 py-1 hoverable disabled:opacity-40">↶</button>
          <button onClick={() => dispatch({ type: "redo" })} disabled={state.future.length === 0}
            className="rounded-ctrl bg-ctrl px-2 py-1 hoverable disabled:opacity-40">↷</button>
          <button onClick={() => dispatch({ type: "clear" })} disabled={cutsX.length + cutsY.length === 0}
            className="rounded-ctrl bg-ctrl px-3 py-1 hoverable disabled:opacity-40">Clear</button>

          <span className="mx-1 h-5 w-px bg-ctrl-hi" />

          <button onClick={() => setZoom((z) => Math.max(0.25, +(z / 1.5).toFixed(4)))} className="rounded-ctrl bg-ctrl px-2 py-1 hoverable">−</button>
          <span className="w-14 text-center font-mono text-ink-2">{Math.round(scale * 100)}%</span>
          <button onClick={() => setZoom((z) => Math.min(16, +(z * 1.5).toFixed(4)))} className="rounded-ctrl bg-ctrl px-2 py-1 hoverable">＋</button>
          <button onClick={() => setZoom(1)} className="rounded-ctrl bg-ctrl px-2 py-1 hoverable">Fit</button>

          <label
            className="ml-auto flex cursor-pointer items-center gap-2 text-ink-2"
            title="Each frame keeps only its own sprite. Pieces of neighbours and lines drawn by the AI become transparent."
          >
            <input type="checkbox" checked={cleanEdges} onChange={(e) => setCleanEdges(e.target.checked)} className="" />
            Clean edges
          </label>

          <label className="flex cursor-pointer items-center gap-2 text-ink-2">
            <input type="checkbox" checked={showProfiles} onChange={(e) => setShowProfiles(e.target.checked)} className="" />
            Profiles
          </label>
        </div>

        {/* canvas */}
        <div className="flex flex-1 justify-center overflow-auto bg-panel p-3">
          {error ? (
            <div className="flex h-64 items-center text-sm text-danger">{error}</div>
          ) : img ? (
            <canvas
              ref={canvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onPointerLeave={onPointerLeave}
              style={{ touchAction: "none", cursor, imageRendering: "pixelated" }}
            />
          ) : (
            <div className="flex h-64 items-center text-ink-3">Loading image…</div>
          )}
        </div>

        {/* measurements */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-1 border-t border-line px-4 py-2 text-xs text-ink-2 sm:grid-cols-4">
          <div>Frames <span className="font-semibold text-icon-on">{frameCount}</span></div>
          <div>Cell <span className="text-ink">{report.modalW} × {report.modalH}</span>{!report.uniform && <span className="text-warn"> (modal)</span>}</div>
          <div>Min cell <span className={report.minCell < MIN_CELL ? "text-danger" : "text-ink"}>{Number.isFinite(report.minCell) ? report.minCell : 0}</span></div>
          <div>Uniformity {report.uniform
            ? <span className="text-success">exact</span>
            : <span className="text-warn">MAD {report.madX}/{report.madY}</span>}</div>
          <div className="col-span-2 sm:col-span-4">
            Seams on gutters:{" "}
            <SeamBadge label="cols" v={report.seamX} />{" "}
            <SeamBadge label="rows" v={report.seamY} />
            <span className="ml-2 text-ink-dim">
              (advisory — nothing is enforced; ↑↓←→ nudges, ⇧ ×8, ⌫ deletes, ⌘Z undoes)
            </span>
          </div>
        </div>

        {/* footer */}
        <div className="flex items-center justify-between border-t border-line px-4 py-3">
          <p className="text-xs text-ink-3">
            {busy
              ? `Encoding ${busy.done} / ${busy.total}…`
              : cleanNote
              ? cleanNote
              : frameCount > MAX_FRAMES
              ? `Too many frames (max ${MAX_FRAMES}).`
              : cleanEdges
              ? "Clean edges on: each frame keeps only its own sprite."
              : "Interior lines only — the outer edges are fixed."}
          </p>
          <div className="flex gap-2">
            <button onClick={onCancel} disabled={!!busy} className="rounded-ctrl bg-ctrl-hi px-4 py-2 hoverable disabled:opacity-40">
              Cancel
            </button>
            <button onClick={handleApply} disabled={!valid || !!busy}
              className="rounded-ctrl bg-primary px-4 py-2 font-semibold hoverable disabled:opacity-40">
              {busy ? `${Math.round((busy.done / busy.total) * 100)}%` : `Apply → ${frameCount} frames`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SeamBadge({ label, v }: { label: string; v: { clean: number; total: number } | null }) {
  if (!v) return <span className="text-ink-dim">{label} —</span>;
  const all = v.clean === v.total;
  return (
    <span className={all ? "text-success" : "text-warn"}>
      {label} {v.clean}/{v.total}
    </span>
  );
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("FileReader returned non-string."));
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed."));
    reader.readAsDataURL(blob);
  });
}