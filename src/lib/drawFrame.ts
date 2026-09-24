/**
 * Now a thin adapter over the compositor.
 *
 * `drawFrameToCanvas` and `drawFrameComposed` keep their exact signatures and
 * output for single-bitmap frames, so Canvas's onion skin and exportGif's loop
 * are untouched. Multi-layer frames route through `compositeLayers`, which is
 * the same code the editor view uses — so what you see is what you export.
 */

import type { Frame } from "@/types/frame";
import type { RenderTransform } from "@/lib/frameTransform";
import { CANVAS_SIZE, fitScale, renderTransform } from "@/lib/frameTransform";
import { compositeLayers, type BitmapResolver } from "@/lib/layers/composite";
import { domResolver } from "@/lib/layers/flatten";
import { DEFAULT_BACKGROUND, type CanvasBackground } from "@/types/layer";

/**
 * Legacy single-bitmap draw. UNCHANGED SEMANTICS: translate before scale,
 * rotate about the surface centre, "contain" fit.
 */
export function drawFrameToCanvas(
  ctx: CanvasRenderingContext2D,
  t: RenderTransform,
  img: HTMLImageElement | HTMLCanvasElement,
  surface: number = CANVAS_SIZE
): void {
  const w = "naturalWidth" in img ? img.naturalWidth : img.width;
  const h = "naturalHeight" in img ? img.naturalHeight : img.height;
  const s = fitScale(w, h, surface) * t.zoom;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(surface / 2 + t.x, surface / 2 + t.y);
  if (t.rotation !== 0) ctx.rotate((t.rotation * Math.PI) / 180);
  ctx.scale(s, s);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
}

/** Composed L1 ⊕ L2 draw — what exportGif calls today. */
export function drawFrameComposed(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  img: HTMLImageElement,
  surface: number = CANVAS_SIZE
): void {
  drawFrameToCanvas(
    ctx,
    renderTransform(frame, img.naturalWidth, img.naturalHeight, surface),
    img,
    surface
  );
}

/** The layer-aware path. Preferred by Canvas and by export. */
export function drawFrameLayers(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  surface: number = CANVAS_SIZE,
  opts: {
    background?: CanvasBackground;
    resolve?: BitmapResolver;
    globalAlpha?: number;
    checkerboard?: boolean;
  } = {}
): void {
  compositeLayers(ctx, frame.layers, opts.resolve ?? domResolver(), {
    surface,
    background: opts.background ?? DEFAULT_BACKGROUND,
    crop: frame.crop,
    drawCheckerboard: opts.checkerboard ?? false,
    globalAlpha: opts.globalAlpha ?? 1,
    onlyLayerIds: null,
    smoothing: false,
  });
}
