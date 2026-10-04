/// <reference lib="webworker" />

/**
 * The stage worker: draws the editor's stage on the canvas the page handed it.
 *
 * Drawing on a page's own canvas costs the main thread twice per frame: the
 * compositing itself, and the browser's copy of the whole canvas for every
 * frame it changes. Here both happen on this thread, and the page only sends
 * what changed.
 *
 * It holds the decoded images and strokes the frames refer to (the client
 * decides what it holds) and draws through StageRenderer, the same code the
 * page runs where it cannot hand its canvas over.
 */

import type { Layer } from "@/types/layer";
import type { PencilStroke } from "@/lib/pencil/types";
import type { BitmapResolver, LayerBitmap } from "@/lib/layers/composite";
import { imageDrawPlan, levelKey, levelSrcRect } from "./geometry";
import { StageRenderer, type LivePencil } from "./renderer";
import type { StageFrame, StageRequest, StageResponse } from "./protocol";

const scope = self as unknown as DedicatedWorkerGlobalScope;

interface HeldImage {
  readonly bitmap: ImageBitmap;
  /** Its mip levels, by levelKey. */
  readonly levels: Map<string, ImageBitmap>;
  /** Draws it the way the page draws a decoded image on the CPU. */
  readonly draw: NonNullable<LayerBitmap["draw"]>;
}

const images = new Map<string, HeldImage>();
const strokes = new Map<number, PencilStroke>();
/** Each layer's stroke list as last drawn. Kept while unchanged: the
 *  compositor's stroke cache knows a list by its identity. */
let lists = new Map<string, readonly PencilStroke[]>();
let live: { key: number; stroke: PencilStroke & { pts: number[] } } | null = null;
let renderer: StageRenderer | null = null;

function hold(bitmap: ImageBitmap): HeldImage {
  const levels = new Map<string, ImageBitmap>();
  const draw: HeldImage["draw"] = (ctx, sx, sy, sw, sh) => {
    if (!ctx.imageSmoothingEnabled) {
      ctx.drawImage(bitmap, sx, sy, sw, sh, sx, sy, sw, sh);
      return;
    }
    const plan = imageDrawPlan(ctx.getTransform(), bitmap.width, bitmap.height, sx, sy, sw, sh);
    if (!plan) return;
    const quality = ctx.imageSmoothingQuality;
    const level = plan.level > 0 ? levels.get(levelKey(plan)) : undefined;
    if (level) {
      ctx.imageSmoothingQuality = "low";
      ctx.drawImage(level, ...levelSrcRect(plan, sx, sy, sw, sh), sx, sy, sw, sh);
    } else {
      // A level that has not arrived: mipmapped resampling stands in for it.
      ctx.imageSmoothingQuality = plan.level > 0 ? "medium" : "low";
      ctx.drawImage(bitmap, sx, sy, sw, sh, sx, sy, sw, sh);
    }
    ctx.imageSmoothingQuality = quality;
  };
  return { bitmap, levels, draw };
}

/** The frame's layers with their strokes looked up by key. */
function layersOf(frame: StageFrame): Layer[] {
  const next = new Map<string, readonly PencilStroke[]>();
  const layers = frame.layers.map((l): Layer => {
    if (!l.strokes) return { ...l, strokes: undefined };
    const list = l.strokes.map((k) => strokes.get(k)).filter((s): s is PencilStroke => !!s);
    const prev = lists.get(l.id);
    const kept = prev && prev.length === list.length && prev.every((s, i) => s === list[i]) ? prev : list;
    next.set(l.id, kept);
    return { ...l, strokes: kept };
  });
  lists = next;
  return layers;
}

const post = (msg: StageResponse): void => scope.postMessage(msg);

scope.onmessage = (e: MessageEvent<StageRequest>) => {
  const m = e.data;
  if (m.type === "init") {
    renderer = new StageRenderer(m.canvas);
    return;
  }
  if (m.type === "pick") {
    post({ type: "picked", id: m.id, rgba: renderer?.pick(m.x, m.y) ?? null });
    return;
  }

  for (const { key, bitmap } of m.images) images.set(key, hold(bitmap));
  for (const { key, level, bitmap } of m.levels) images.get(key)?.levels.set(level, bitmap);
  for (const { key, stroke } of m.strokes) strokes.set(key, stroke);
  for (const key of m.drop.images) images.delete(key);
  for (const key of m.drop.strokes) strokes.delete(key);

  let pencil: LivePencil | null = null;
  if (m.live?.kind === "pencil") {
    if (live?.key !== m.live.key) live = { key: m.live.key, stroke: { ...m.live.stroke, pts: [] } };
    for (const v of m.live.pts) live.stroke.pts.push(v);
    pencil = { kind: "pencil", layerId: m.live.layerId, stroke: live.stroke };
  }

  const resolve: BitmapResolver = (layer) => {
    const held = layer.image ? images.get(layer.image) : undefined;
    if (!held) return null;
    const { bitmap } = held;
    return {
      layerId: layer.id,
      image: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      ...(m.emulate && { draw: held.draw }),
    };
  };
  try {
    renderer?.draw({
      size: m.size,
      frame: { layers: layersOf(m.frame), crop: m.frame.crop },
      background: m.background,
      interactive: m.interactive,
      resolve,
      live: m.live?.kind === "raster" ? m.live : pencil,
    });
  } finally {
    post({ type: "drawn" });
  }
};
