/**
 * The eyedropper.
 *
 * Returns STRAIGHT (un-premultiplied) colour, always. That is the only answer
 * that round-trips: picking a pixel and painting it back must reproduce the
 * pixel, and premultiplied values do not have that property at partial alpha.
 *
 * Area sampling is ALPHA-WEIGHTED. The naive average over a disc includes
 * transparent pixels as (0,0,0,0), which drags every sample near an edge
 * toward black — the single most common eyedropper bug, and the reason
 * `alphaThreshold` exists.
 */

import type { Vec2 } from "@/types/geometry";
import type { EyedropperResult, EyedropperSettings, RGBA } from "@/types/raster";
import { RasterSurface } from "./surface";
import { CHANNELS } from "./constants";
import { rgbaToHsva, toHex, unpremultiply } from "./color";
import { TRANSPARENT } from "./color";

const empty = (): EyedropperResult => ({
  color: TRANSPARENT,
  hex: "#000000",
  hsva: { h: 0, s: 0, v: 0, a: 0 },
  sampleCount: 0,
});

const describe = (color: RGBA, count: number): EyedropperResult => ({
  color,
  hex: toHex(color),
  hsva: rgbaToHsva(color),
  sampleCount: count,
});

/** Single pixel. Floors to the containing pixel, so the sample is the pixel
 *  the cursor is visibly over. */
export function pickColor(surface: RasterSurface, point: Vec2): EyedropperResult {
  const x = Math.floor(point.x), y = Math.floor(point.y);
  if (!surface.inBounds(x, y)) return empty();
  const c = surface.getColor(x, y);
  return describe(c, c.a > 0 ? 1 : 0);
}

/**
 * Disc average, alpha-weighted.
 *
 * Colour is accumulated in PREMULTIPLIED form and un-premultiplied once at the
 * end, which is exactly equivalent to weighting each contribution by its own
 * alpha — the mathematically correct average of a set of translucent samples,
 * and it needs no separate weight accumulator.
 */
export function pickColorArea(
  surface: RasterSurface,
  settings: EyedropperSettings
): EyedropperResult {
  const r = Math.max(0, settings.radius);
  if (r < 0.5) return pickColor(surface, settings.point);

  const cx = settings.point.x, cy = settings.point.y;
  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(surface.width, Math.ceil(cx + r) + 1);
  const y1 = Math.min(surface.height, Math.ceil(cy + r) + 1);

  const threshold = Math.max(0, settings.alphaThreshold);
  const r2 = r * r;
  let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy > r2) continue; // disc, not square
      const i = surface.index(x, y);
      const a = surface.data[i + 3];
      if (a <= threshold) continue;
      sr += surface.data[i];
      sg += surface.data[i + 1];
      sb += surface.data[i + 2];
      sa += a;
      n++;
    }
  }
  if (n === 0 || sa <= 0) return empty();

  const inv = 1 / n;
  return describe(
    unpremultiply({ r: sr * inv, g: sg * inv, b: sb * inv, a: sa * inv }),
    n
  );
}

/**
 * Sample from a composited RGBA buffer rather than a single layer.
 *
 * The behaviour users expect by default: the dropper should pick what is
 * VISIBLE, which is the composite, not the active layer in isolation.
 */
export function pickColorFromComposite(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  settings: EyedropperSettings
): EyedropperResult {
  const r = Math.max(0, settings.radius);
  const cx = settings.point.x, cy = settings.point.y;

  if (r < 0.5) {
    const x = Math.floor(cx), y = Math.floor(cy);
    if (x < 0 || y < 0 || x >= width || y >= height) return empty();
    const p = (y * width + x) * 4;
    const c: RGBA = {
      r: data[p] / 255, g: data[p + 1] / 255,
      b: data[p + 2] / 255, a: data[p + 3] / 255,
    };
    return describe(c, c.a > 0 ? 1 : 0);
  }

  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(width, Math.ceil(cx + r) + 1);
  const y1 = Math.min(height, Math.ceil(cy + r) + 1);
  const threshold = Math.max(0, settings.alphaThreshold) * 255;
  const r2 = r * r;

  let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy > r2) continue;
      const p = (y * width + x) * 4;
      const a = data[p + 3];
      if (a <= threshold) continue;
      // Source is straight RGBA, so premultiply before averaging to get the
      // same alpha weighting as the surface path.
      const af = a / 255;
      sr += (data[p] / 255) * af;
      sg += (data[p + 1] / 255) * af;
      sb += (data[p + 2] / 255) * af;
      sa += af;
      n++;
    }
  }
  if (n === 0 || sa <= 0) return empty();
  const inv = 1 / n;
  return describe(unpremultiply({ r: sr * inv, g: sg * inv, b: sb * inv, a: sa * inv }), n);
}
    