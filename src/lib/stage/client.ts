/**
 * The editor's stage, drawn by a worker.
 *
 * The page hands its stage canvas to the stage worker once, on mount; from
 * then on every draw is a message. The worker's drawing — the compositor, and
 * the browser's copy of the canvas for each frame it changes — no longer
 * costs the page's main thread anything.
 *
 * Decoded images and strokes cross once and are named by key afterwards: an
 * image as a pixel-for-pixel copy of the page's decoded <img>, plus the mip
 * levels the page's own CPU raster would make of it (stage/geometry.ts), so
 * the stage looks exactly as it did when the page drew it. Where a canvas
 * cannot be handed to a worker, the same renderer draws it on the page.
 */

import type { Frame } from "@/types/frame";
import type { CanvasBackground, Layer } from "@/types/layer";
import type { PencilStroke } from "@/lib/pencil/types";
import { domResolver, getCachedBitmap } from "@/lib/layers/flatten";
import { layerContentBox } from "@/lib/layers/layerSpace";
import { imageDrawPlan, levelKey, stageMatrix, type ImageDrawPlan } from "./geometry";
import { StageRenderer, type LivePencil, type LiveRaster } from "./renderer";
import type { StageFrame, StageLayer, StageLivePencil, StageRequest, StageResponse } from "./protocol";

/** What makes the draw for a stroke in progress, when it is sent (null:
 *  nothing to draw any more). */
export type StagePreview = () => StageDrawInput | null;

export interface StageDrawInput {
  /** Edge of the stage, in device pixels. */
  readonly size: number;
  readonly frame: Pick<Frame, "layers" | "crop">;
  readonly background: CanvasBackground;
  /** The view is changing (see CompositeOptions.interactive). */
  readonly interactive?: boolean;
  readonly live?: LiveRaster | LivePencil | null;
}

/** Pixels the worker may hold, in bytes, and stroke samples, in numbers. */
const IMAGE_BUDGET = 192 * 1024 * 1024;
const STROKE_BUDGET = 4_000_000;
const MAX_IMAGES = 512;

interface HeldImage {
  readonly key: string;
  width: number;
  height: number;
  /** The worker has it (it is sent once it has decoded). */
  sent: boolean;
  readonly levels: Set<string>;
  bytes: number;
  used: number;
}

interface Outgoing {
  images: { key: string; bitmap: ImageBitmap }[];
  levels: { key: string; level: string; bitmap: ImageBitmap }[];
  strokes: { key: number; stroke: PencilStroke }[];
  transfer: Transferable[];
}

/** A decoded image, copied pixel for pixel: drawn 1:1, it is not resampled. */
function copyImage(img: HTMLImageElement): ImageBitmap | null {
  const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  return c.transferToImageBitmap();
}

/** A mip level of a decoded image, as the decode cache makes it: drawing the
 *  image at the level's size makes the cache make exactly that level, which
 *  is then copied 1:1. */
function makeLevel(img: HTMLImageElement, p: ImageDrawPlan): ImageBitmap | null {
  const c = new OffscreenCanvas(p.w, p.h);
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, p.src.x, p.src.y, p.src.w, p.src.h, 0, 0, p.w, p.h);
  return c.transferToImageBitmap();
}

/**
 * Whether the page's canvases draw decoded images on the CPU path the worker
 * reproduces (geometry.ts). An enlarged image tells: there, "high" quality
 * draws exactly like "low"; a GPU canvas honours it. Assumed until known.
 */
let emulate = true;
let probed = false;
function probeImagePath(): void {
  if (probed || typeof document === "undefined") return;
  probed = true;
  const art = document.createElement("canvas");
  art.width = art.height = 2;
  const actx = art.getContext("2d");
  if (!actx) return;
  actx.fillStyle = "#000";
  actx.fillRect(0, 0, 2, 2);
  actx.fillStyle = "#fff";
  actx.fillRect(0, 0, 1, 1);
  actx.fillRect(1, 1, 1, 1);
  const img = new Image();
  img.src = art.toDataURL("image/png");
  img.decode().then(
    () => {
      const read = (quality: ImageSmoothingQuality) => {
        const c = document.createElement("canvas");
        c.width = c.height = 256;
        const ctx = c.getContext("2d");
        if (!ctx) return null;
        ctx.imageSmoothingQuality = quality;
        ctx.drawImage(img, 0, 0, 256, 256);
        return ctx.getImageData(0, 0, 256, 256).data;
      };
      const high = read("high");
      const low = read("low");
      if (high && low) emulate = high.every((v, i) => v === low[i]);
    },
    () => {}
  );
}

/** The client a canvas was handed to, kept on the element: React may mount
 *  the same canvas again, and it can only be handed over once. */
const CLIENT = Symbol.for("loopsmith.stage");
type StageElement = HTMLCanvasElement & { [CLIENT]?: StageClient };

export class StageClient {
  private worker: Worker | null = null;
  private local: StageRenderer | null = null;
  private users = 0;
  private closing: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private draws = 0;
  /** What the worker holds, least recently used first. */
  private readonly images = new Map<string, HeldImage>();
  private imageBytes = 0;
  private readonly strokeKeys = new WeakMap<PencilStroke, number>();
  private readonly strokes = new Map<number, { size: number; used: number }>();
  private strokeSize = 0;
  /** The pencil stroke in progress, and how many of its numbers were sent. */
  private live: { stroke: PencilStroke; key: number; sent: number } | null = null;
  /** Draws sent and not yet on the canvas. While one is, later ones wait:
   *  the latest frame draw, and the stroke preview, made when it is sent so
   *  it carries everything up to then. The worker never falls behind the pen. */
  private inFlight = 0;
  private waitingDraw: StageDrawInput | null = null;
  private waitingPreview: StagePreview | null = null;
  private readonly picks = new Map<number, (rgba: Uint8ClampedArray | null) => void>();

  /** The stage client for this canvas. Call `release` when done with it. */
  static attach(canvas: HTMLCanvasElement): StageClient {
    const el = canvas as StageElement;
    const client = (el[CLIENT] ??= new StageClient(canvas));
    client.users++;
    if (client.closing) {
      clearTimeout(client.closing);
      client.closing = null;
    }
    return client;
  }

  private constructor(private readonly canvas: HTMLCanvasElement) {
    probeImagePath();
    if (typeof canvas.transferControlToOffscreen === "function" && typeof Worker !== "undefined") {
      let worker: Worker | null = null;
      try {
        worker = new Worker(new URL("./stage.worker.ts", import.meta.url), { type: "module" });
        const offscreen = canvas.transferControlToOffscreen();
        worker.onmessage = (e: MessageEvent<StageResponse>) => this.answer(e.data);
        worker.onerror = (e) => console.error("stage worker:", e.message);
        this.worker = worker;
        this.post({ type: "init", canvas: offscreen }, [offscreen]);
      } catch {
        worker?.terminate();
        this.worker = null;
      }
    }
    if (!this.worker) this.local = new StageRenderer(canvas);
  }

  /** Done with it. The worker stops once the canvas has left the page. */
  release(): void {
    if (--this.users > 0) return;
    // The same canvas may be mounted again at once (React Strict Mode), or
    // be kept while hidden: only a canvas that has left the page lets go.
    this.closing = setTimeout(() => {
      this.closing = null;
      if (this.users > 0 || this.canvas.isConnected) return;
      this.worker?.terminate();
      this.worker = null;
      this.waitingDraw = null;
      this.waitingPreview = null;
      this.local?.dispose();
      this.local = null;
      for (const answer of this.picks.values()) answer(null);
      this.picks.clear();
      delete (this.canvas as StageElement)[CLIENT];
    }, 0);
  }

  /** Whether a worker draws the stage (else it is drawn here, at once). */
  get offThread(): boolean {
    return !!this.worker;
  }

  /** Draw the frame. */
  draw(input: StageDrawInput): void {
    if (this.local) {
      this.local.draw({
        ...input,
        interactive: input.interactive ?? false,
        resolve: domResolver(),
        live: input.live ?? null,
      });
      return;
    }
    if (!this.worker) return;
    if (this.inFlight > 0) this.waitingDraw = input;
    else this.send(input);
  }

  /** Draw the stroke in progress: `make` is called once the worker can take
   *  the draw (at once if it is idle). */
  preview(make: StagePreview): void {
    if (this.local) {
      const input = make();
      if (input) this.draw(input);
      return;
    }
    if (!this.worker) return;
    if (this.inFlight > 0) this.waitingPreview = make;
    else {
      const input = make();
      if (input) this.send(input);
    }
  }

  private send(input: StageDrawInput): void {
    const interactive = input.interactive ?? false;
    const live = input.live ?? null;
    this.inFlight++;
    const now = ++this.draws;
    const out: Outgoing = { images: [], levels: [], strokes: [], transfer: [] };
    const frame = this.describe(input.frame, input.size, now, out);

    let wire: LiveRaster | StageLivePencil | null = null;
    if (live?.kind === "raster") {
      wire = live;
      out.transfer.push(live.pixels.buffer);
    } else if (live) {
      if (this.live?.stroke !== live.stroke) this.live = { stroke: live.stroke, key: ++this.seq, sent: 0 };
      const { pts, ...stroke } = live.stroke;
      wire = { kind: "pencil", layerId: live.layerId, key: this.live.key, stroke, pts: pts.slice(this.live.sent) };
      this.live.sent = pts.length;
    }

    this.post(
      {
        type: "draw",
        size: input.size,
        frame,
        background: input.background,
        interactive,
        emulate,
        images: out.images,
        levels: out.levels,
        strokes: out.strokes,
        drop: this.evict(now),
        live: wire,
      },
      out.transfer
    );
  }

  /** The stage pixel at (x, y), as RGBA bytes, once the stage has drawn
   *  everything asked of it so far. */
  pick(x: number, y: number): Promise<Uint8ClampedArray | null> {
    if (this.local) return Promise.resolve(this.local.pick(x, y));
    if (!this.worker) return Promise.resolve(null);
    this.flush();
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.picks.set(id, resolve);
      this.post({ type: "pick", id, x, y });
    });
  }

  private answer(m: StageResponse): void {
    if (m.type === "drawn") {
      if (--this.inFlight === 0) this.flush();
      return;
    }
    this.picks.get(m.id)?.(m.rgba);
    this.picks.delete(m.id);
  }

  /** Send what waits. A preview is made after any frame draw asked for
   *  before it, so it starts over in full and stands for both. */
  private flush(): void {
    const make = this.waitingPreview;
    const draw = this.waitingDraw;
    this.waitingPreview = null;
    this.waitingDraw = null;
    const next = make?.() ?? draw;
    if (next) this.send(next);
  }

  private post(msg: StageRequest, transfer: Transferable[] = []): void {
    this.worker?.postMessage(msg, transfer);
  }

  /** The frame by key, with whatever the worker does not hold yet. */
  private describe(frame: Pick<Frame, "layers" | "crop">, size: number, now: number, out: Outgoing): StageFrame {
    const layers = frame.layers.map((l): StageLayer => {
      const image = l.image ? this.image(l.image, now, out) : null;
      if (image && emulate && l.visible) this.level(l, image, size, out);
      return {
        ...l,
        image: image ? image.key : l.image,
        mask: l.mask?.image ? { ...l.mask, image: this.image(l.mask.image, now, out).key } : l.mask,
        strokes: l.strokes?.map((s) => this.stroke(s, now, out)),
      };
    });
    return { layers, crop: frame.crop };
  }

  private image(src: string, now: number, out: Outgoing): HeldImage {
    let held = this.images.get(src);
    if (held) this.images.delete(src);
    else held = { key: `i${++this.seq}`, width: 0, height: 0, sent: false, levels: new Set(), bytes: 0, used: now };
    held.used = now;
    this.images.set(src, held);
    if (!held.sent) {
      // Not decoded yet: the layer is skipped until it is (the page repaints then).
      const img = getCachedBitmap(src);
      const bitmap = img ? copyImage(img) : null;
      if (bitmap) {
        held.sent = true;
        held.width = bitmap.width;
        held.height = bitmap.height;
        held.bytes = bitmap.width * bitmap.height * 4;
        this.imageBytes += held.bytes;
        out.images.push({ key: held.key, bitmap });
        out.transfer.push(bitmap);
      }
    }
    return held;
  }

  /** The mip level the layer's image is drawn from at this stage size, if it
   *  is drawn shrunk and the worker lacks it. */
  private level(l: Layer, held: HeldImage, size: number, out: Outgoing): void {
    if (!held.sent || !l.image) return;
    // The rect the compositor draws (drawCropped).
    const box = layerContentBox(l);
    const sx = Math.max(0, Math.min(box.x, held.width));
    const sy = Math.max(0, Math.min(box.y, held.height));
    const sw = Math.max(0, Math.min(box.w, held.width - sx));
    const sh = Math.max(0, Math.min(box.h, held.height - sy));
    if (sw <= 0 || sh <= 0) return;
    const plan = imageDrawPlan(stageMatrix(l, size), held.width, held.height, sx, sy, sw, sh);
    if (!plan || plan.level === 0) return;
    const key = levelKey(plan);
    if (held.levels.has(key)) return;
    const img = getCachedBitmap(l.image);
    const bitmap = img ? makeLevel(img, plan) : null;
    if (!bitmap) return;
    held.levels.add(key);
    held.bytes += plan.w * plan.h * 4;
    this.imageBytes += plan.w * plan.h * 4;
    out.levels.push({ key: held.key, level: key, bitmap });
    out.transfer.push(bitmap);
  }

  private stroke(s: PencilStroke, now: number, out: Outgoing): number {
    let key = this.strokeKeys.get(s);
    if (key === undefined) {
      key = ++this.seq;
      this.strokeKeys.set(s, key);
    }
    let held = this.strokes.get(key);
    if (held) this.strokes.delete(key);
    else {
      held = { size: s.pts.length, used: now };
      this.strokeSize += held.size;
      out.strokes.push({ key, stroke: s });
    }
    held.used = now;
    this.strokes.set(key, held);
    return key;
  }

  /** Let go of the least recently drawn images and strokes over budget. */
  private evict(now: number): { images: string[]; strokes: number[] } {
    const drop = { images: [] as string[], strokes: [] as number[] };
    for (const [src, held] of this.images) {
      if (held.used === now) break;
      if (this.imageBytes <= IMAGE_BUDGET && this.images.size <= MAX_IMAGES) break;
      this.images.delete(src);
      this.imageBytes -= held.bytes;
      if (held.sent) drop.images.push(held.key);
    }
    for (const [key, held] of this.strokes) {
      if (held.used === now || this.strokeSize <= STROKE_BUDGET) break;
      this.strokes.delete(key);
      this.strokeSize -= held.size;
      drop.strokes.push(key);
    }
    return drop;
  }
}
