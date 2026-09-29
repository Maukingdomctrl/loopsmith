/**
 * Brush previews, drawn by the brush itself.
 *
 * Nothing in the panel is an icon. Each preview is produced by running the real
 * engine over synthetic input — a curved stroke, a single tap, a pressure ramp —
 * on a small off-screen surface, so the panel shows exactly what the brush will
 * do, at any material and in the current colour, and can never drift out of
 * date with the engine.
 *
 * Pure: no DOM, no timers, deterministic. The caller puts the pixels on a
 * canvas.
 */

import type { RGBA } from "@/types/raster";
import { RasterSurface } from "../surface";
import { MaterialStroke } from "./materialStroke";
import type { BrushId, BrushSpec } from "./types";

export type PreviewKind = "stroke" | "pressure" | "tip";

export interface PreviewRequest {
  readonly brush: BrushSpec;
  readonly kind: PreviewKind;
  /** Output size in pixels. */
  readonly width: number;
  readonly height: number;
  readonly color: RGBA;
  readonly material?: string;
  readonly angle?: number;
  /** Straight RGB 0..1 the preview is composited onto. */
  readonly background: readonly [number, number, number];
  /** Pixel density: the surface is drawn at this multiple, sizes scale with it. */
  readonly scale?: number;
}

/**
 * Nominal brush radius for each preview, as a fraction of the preview height.
 * Chosen per brush so each one is shown at a size where its character reads:
 * a hairline pen is drawn thin, a broad soft rectangle wide.
 */
const STROKE_RADIUS: Record<BrushId, number> = {
  softRound: 0.27,
  softRect: 0.15,
  hardLine: 0.07,
  water: 0.26,
  texture: 0.24,
};
const TIP_RADIUS: Record<BrushId, number> = {
  softRound: 0.36,
  softRect: 0.17,
  hardLine: 0.3,
  water: 0.36,
  texture: 0.34,
};

/** Straight RGBA bytes: the brush composited onto `background`. */
export function renderBrushPreview(req: PreviewRequest): Uint8ClampedArray<ArrayBuffer> {
  const k = req.scale ?? 1;
  const W = Math.max(2, Math.round(req.width * k));
  const H = Math.max(2, Math.round(req.height * k));
  const surface = new RasterSurface(W, H);
  const spec = req.brush;
  const angle = ((req.angle ?? 0) * Math.PI) / 180;

  const radiusFrac = req.kind === "tip" ? TIP_RADIUS[spec.id] : STROKE_RADIUS[spec.id];
  const stroke = new MaterialStroke(surface, {
    brush: spec,
    color: req.color,
    radius: radiusFrac * H,
    intensity: Math.max(0.6, spec.defaultIntensity),
    material: req.material,
    angle,
    // a preview shows the pen at its best: real pressure, so the response is
    // the brush's own rather than the mouse stand-in
    hasPressure: true,
    scale: k,
    seed: 3,
  });

  const T0 = 1000;
  if (req.kind === "tip") {
    stroke.addSample({ x: W / 2, y: H / 2, pressure: 0.85, tilt: 0, twist: 0, time: T0 });
  } else {
    const margin = spec.shape === "rect" ? H * 0.5 : H * 0.42;
    const x0 = margin, x1 = W - margin;
    const n = Math.max(24, Math.round((x1 - x0) / (3 * k)));
    const wave = req.kind === "stroke" ? H * 0.2 : 0;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const pressure =
        req.kind === "pressure"
          ? 0.03 + 0.97 * u
          : 0.55 + 0.35 * Math.sin(u * Math.PI);
      stroke.addSample({
        x: x0 + (x1 - x0) * u,
        y: H / 2 + Math.sin(u * Math.PI * 2) * wave,
        pressure,
        tilt: 0,
        twist: 0,
        time: T0 + i * 16,
      });
    }
  }
  stroke.end();

  const out = new Uint8ClampedArray(new ArrayBuffer(W * H * 4));
  const [br, bg, bb] = req.background;
  const d = surface.data;
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const a = d[p + 3];
    out[p]     = Math.round((d[p]     + br * (1 - a)) * 255);
    out[p + 1] = Math.round((d[p + 1] + bg * (1 - a)) * 255);
    out[p + 2] = Math.round((d[p + 2] + bb * (1 - a)) * 255);
    out[p + 3] = 255;
  }
  return out;
}

/** Warm paper for most colours; a dark slate when the colour would vanish on it. */
export function previewBackground(color: RGBA): readonly [number, number, number] {
  const lum = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
  return lum > 0.82 ? [0.13, 0.15, 0.19] : [0.94, 0.93, 0.9];
}
