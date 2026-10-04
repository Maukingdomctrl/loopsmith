/**
 * The stage: the frame being edited, drawn at the screen's pixel density, with
 * the live preview of a stroke in progress on top of the committed layers.
 *
 * Runs in the stage worker, on the canvas the page handed it (client.ts), or
 * on the page's own canvas where a canvas cannot be handed over. Either way
 * the pixels come from the compositor, drawn the way the editor always drew
 * them.
 */

import type { Frame } from "@/types/frame";
import type { CanvasBackground } from "@/types/layer";
import type { Rect } from "@/types/geometry";
import type { PencilStroke } from "@/lib/pencil/types";
import { drawFrameLayers } from "@/lib/drawFrame";
import {
  markLiveStroke,
  onStrokeRefine,
  type BitmapResolver,
  type Surface2D,
} from "@/lib/layers/composite";

export type StageCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * A brush stroke (or a shape, or anything on a mask) in progress: the working
 * surface stands in for the painted layer's pixels or mask, so the stroke
 * shows in its place in the stack, with its blend, opacity and mask.
 */
export interface LiveRaster {
  readonly kind: "raster";
  readonly layerId: string;
  /** The surface holds the layer's mask, not its pixels. */
  readonly mask: boolean;
  /** How the surface is resampled: as the committed image will be. */
  readonly quality: ImageSmoothingQuality;
  /** Size of the surface. */
  readonly width: number;
  readonly height: number;
  /** The surface pixels that changed, as 8-bit RGBA. */
  readonly rect: Rect;
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  /** Redraw the whole stage; otherwise only `area` (nothing when null). */
  readonly full: boolean;
  readonly area: Rect | null;
}

/** A pencil or eraser stroke in progress: drawn as the layer's last stroke. */
export interface LivePencil {
  readonly kind: "pencil";
  readonly layerId: string;
  /** Its samples grow in place until pen-up. */
  readonly stroke: PencilStroke;
}

export interface StageDraw {
  /** Edge of the stage, in device pixels. */
  readonly size: number;
  readonly frame: Pick<Frame, "layers" | "crop">;
  readonly background: CanvasBackground;
  /** The view is changing: pencil layers may show a stand-in for a moment. */
  readonly interactive: boolean;
  readonly resolve: BitmapResolver;
  readonly live: LiveRaster | LivePencil | null;
}

/** A canvas's 2D context, whichever kind of canvas it is. */
const context2d = (c: StageCanvas): Surface2D | null =>
  (c as OffscreenCanvas).getContext("2d", { alpha: true });

function makeCanvas(w: number, h: number): StageCanvas {
  if (typeof document === "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export class StageRenderer {
  /** The live surface, as a canvas the compositor can draw. */
  private scratch: StageCanvas | null = null;
  /** Draws the stage as it now stands, in full. */
  private repaint: (() => void) | null = null;
  private readonly unsubscribe: () => void;

  constructor(private readonly canvas: StageCanvas) {
    // A pencil layer shown as a stand-in while the view changed has been
    // rendered exactly: repaint.
    this.unsubscribe = onStrokeRefine(() => this.repaint?.());
  }

  dispose(): void {
    this.unsubscribe();
    this.repaint = null;
  }

  draw(d: StageDraw): void {
    const canvas = this.canvas;
    const size = d.size;
    if (canvas.width !== size) canvas.width = size;
    if (canvas.height !== size) canvas.height = size;
    const ctx = context2d(canvas);
    if (!ctx) return;
    const live = d.live;
    if (live?.kind === "raster") {
      this.drawRaster(ctx, d, live);
      return;
    }

    // A pencil stroke in progress is the painted layer's last stroke; the
    // compositor renders it incrementally (markLiveStroke).
    if (live) markLiveStroke(live.stroke);
    const frame = live
      ? {
          ...d.frame,
          layers: d.frame.layers.map((l) =>
            l.id === live.layerId ? { ...l, strokes: [...(l.strokes ?? []), live.stroke] } : l
          ),
        }
      : d.frame;
    const options = {
      background: d.background,
      resolve: d.resolve,
      checkerboard: true,
      interactive: d.interactive,
      smoothing: true,
    };
    const full = () => {
      // Always repaint from a clean surface.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size, size);
      drawFrameLayers(ctx, frame, size, options);
    };
    full();
    this.repaint = full;
  }

  private drawRaster(ctx: Surface2D, d: StageDraw, live: LiveRaster): void {
    const size = d.size;
    const scratch = (this.scratch ??= makeCanvas(live.width, live.height));
    if (scratch.width !== live.width) scratch.width = live.width;
    if (scratch.height !== live.height) scratch.height = live.height;
    const sctx = context2d(scratch);
    if (!sctx) return;
    const r = live.rect;
    if (r.w > 0 && r.h > 0) sctx.putImageData(new ImageData(live.pixels, r.w, r.h), r.x, r.y);

    // A mask preview answers for the mask; a pixel preview for the layer.
    const liveId = live.mask ? `${live.layerId}#mask` : live.layerId;
    const resolve: BitmapResolver = (l) =>
      l.id === liveId
        ? { layerId: liveId, image: scratch, width: scratch.width, height: scratch.height, quality: live.quality }
        : d.resolve(l);
    const frame = {
      ...d.frame,
      // Any non-null image makes the (maybe blank) layer or mask render;
      // the resolver hands back the live surface for it.
      layers: d.frame.layers.map((l) =>
        l.id !== live.layerId
          ? l
          : live.mask && l.mask
            ? { ...l, mask: { ...l.mask, image: "live" } }
            : { ...l, image: "live" }
      ),
    };
    const options = { background: d.background, resolve, checkerboard: true, smoothing: true };
    const full = () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size, size);
      drawFrameLayers(ctx, frame, size, options);
    };
    this.repaint = full;
    if (live.full) {
      full();
      return;
    }

    // Only the stage pixels the changed surface pixels land on.
    const area = live.area;
    if (!area) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(area.x, area.y, area.w, area.h);
    ctx.clip();
    drawFrameLayers(ctx, frame, size, { ...options, region: area });
    ctx.restore();
  }

  /** The stage pixel at (x, y), as RGBA bytes. */
  pick(x: number, y: number): Uint8ClampedArray | null {
    const { width, height } = this.canvas;
    const ctx = context2d(this.canvas);
    if (!ctx || width < 1 || height < 1) return null;
    return ctx.getImageData(
      Math.max(0, Math.min(width - 1, x)),
      Math.max(0, Math.min(height - 1, y)),
      1,
      1
    ).data;
  }
}
