/**
 * Colour conversion and per-pixel blending.
 *
 * The premultiply boundary is the whole point of this file. The surface stores
 * premultiplied float RGBA because that is the only representation in which
 * source-over is a linear operation — and therefore the only one in which
 * thousands of stacked brush stamps do not accumulate a colour shift.
 * Everything the user sees or picks is STRAIGHT alpha. Confusing the two is
 * how semi-transparent pixels sample as mud.
 */

import type { BlendMode } from "@/types/layer";
import type { HSVA, PremultipliedRGBA, RGBA } from "@/types/raster";
import { clamp } from "@/lib/geometry/scalar";

export const rgba = (r: number, g: number, b: number, a = 1): RGBA =>
  ({ r, g, b, a });

export const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };

export const premultiply = (c: RGBA): PremultipliedRGBA =>
  ({ r: c.r * c.a, g: c.g * c.a, b: c.b * c.a, a: c.a });

/** Inverse of premultiply. Returns transparent black for a = 0, which is the
 *  only defensible answer: the colour of a fully transparent pixel is
 *  genuinely undefined, and inventing one produces halos. */
export function unpremultiply(c: PremultipliedRGBA): RGBA {
  if (c.a <= 0) return TRANSPARENT;
  const inv = 1 / c.a;
  return {
    r: clamp(c.r * inv, 0, 1),
    g: clamp(c.g * inv, 0, 1),
    b: clamp(c.b * inv, 0, 1),
    a: clamp(c.a, 0, 1),
  };
}

/* ---------- 8-bit ---------- */

export const from8 = (r: number, g: number, b: number, a: number): RGBA =>
  ({ r: r / 255, g: g / 255, b: b / 255, a: a / 255 });

/** Round-half-away-from-zero, matching what Canvas2D does, so a round trip
 *  through a DOM canvas is a fixed point. */
export const to8 = (v: number): number =>
  Math.max(0, Math.min(255, Math.round(clamp(v, 0, 1) * 255)));

/* ---------- hex ---------- */

const HEX = /^#?([0-9a-f]{3,8})$/i;

/** Accepts #rgb, #rgba, #rrggbb, #rrggbbaa. Returns null rather than throwing,
 *  because this is fed directly from a text input. */
export function parseHex(input: string): RGBA | null {
  const m = HEX.exec(input.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) return null;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

export function toHex(c: RGBA, includeAlpha = false): string {
  const p = (v: number) => to8(v).toString(16).padStart(2, "0");
  return `#${p(c.r)}${p(c.g)}${p(c.b)}${includeAlpha ? p(c.a) : ""}`;
}

/* ---------- HSV ---------- */

export function rgbaToHsva(c: RGBA): HSVA {
  const max = Math.max(c.r, c.g, c.b);
  const min = Math.min(c.r, c.g, c.b);
  const d = max - min;

  let h = 0;
  // Hue is undefined for greys; 0 is the conventional choice and keeps a
  // saturation slider from jumping when the user desaturates to pure grey.
  if (d > 0) {
    if (max === c.r) h = ((c.g - c.b) / d) % 6;
    else if (max === c.g) h = (c.b - c.r) / d + 2;
    else h = (c.r - c.g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max, a: c.a };
}

export function hsvaToRgba(c: HSVA): RGBA {
  const h = ((c.h % 360) + 360) % 360 / 60;
  const s = clamp(c.s, 0, 1);
  const v = clamp(c.v, 0, 1);
  const i = Math.floor(h);
  const f = h - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const table: [number, number, number][] = [
    [v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q],
  ];
  const [r, g, b] = table[i % 6];
  return { r, g, b, a: clamp(c.a, 0, 1) };
}

/* ---------- sRGB transfer ---------- */

/** Exact IEC 61966-2-1 curve, not the 2.2 approximation — the linear toe
 *  matters when averaging dark pixels in the eyedropper. */
export const srgbToLinear = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);

export const linearToSrgb = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

export const luminance = (c: RGBA): number =>
  0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);

/* ---------- blending ---------- */

/** Separable blend functions, operating on STRAIGHT channels. */
function blendChannel(mode: BlendMode, cb: number, cs: number): number {
  switch (mode) {
    case "multiply":   return cb * cs;
    case "screen":     return cb + cs - cb * cs;
    case "overlay":    return cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs);
    case "darken":     return Math.min(cb, cs);
    case "lighten":    return Math.max(cb, cs);
    case "difference": return Math.abs(cb - cs);
    default:           return cs;
  }
}

/**
 * Composite a source colour over a premultiplied destination, in place, at
 * effective alpha `alpha`.
 *
 * Implements the PDF/SVG general formula rather than a shortcut:
 *
 *   co = as·(1−ab)·Cs + as·ab·B(Cb,Cs) + (1−as)·ab·Cb
 *
 * The middle term is the one naive implementations drop; without it every
 * non-normal blend mode is wrong wherever the destination is semi-transparent,
 * which on a layer being painted is almost everywhere.
 *
 * Returns nothing; writes four floats at `out[i]`.
 */
export function compositeInto(
  out: Float32Array,
  i: number,
  srcR: number,
  srcG: number,
  srcB: number,
  alpha: number,
  mode: BlendMode
): void {
  const as = alpha;
  if (as <= 0) return;

  const dr = out[i], dg = out[i + 1], db = out[i + 2], ab = out[i + 3];

  if (mode === "normal") {
    const inv = 1 - as;
    out[i]     = srcR * as + dr * inv;
    out[i + 1] = srcG * as + dg * inv;
    out[i + 2] = srcB * as + db * inv;
    out[i + 3] = as + ab * inv;
    return;
  }

  // Un-premultiply the backdrop to blend, per the spec.
  const invAb = ab > 0 ? 1 / ab : 0;
  const cbR = dr * invAb, cbG = dg * invAb, cbB = db * invAb;

  const bR = blendChannel(mode, cbR, srcR);
  const bG = blendChannel(mode, cbG, srcG);
  const bB = blendChannel(mode, cbB, srcB);

  const w1 = as * (1 - ab);
  const w2 = as * ab;
  const w3 = (1 - as) * ab;

  out[i]     = w1 * srcR + w2 * bR + w3 * cbR;
  out[i + 1] = w1 * srcG + w2 * bG + w3 * cbG;
  out[i + 2] = w1 * srcB + w2 * bB + w3 * cbB;
  out[i + 3] = as + ab * (1 - as);
}

/**
 * Normalized weighted RGBA distance, 0..1. Used by the flood fill.
 *
 * Luma-weighted rather than Euclidean, so a green shift registers as the large
 * perceptual change it is, and alpha carries full weight because an alpha edge
 * is a hard visual boundary regardless of colour.
 */
export function colorDistance(
  r1: number, g1: number, b1: number, a1: number,
  r2: number, g2: number, b2: number, a2: number,
  wr: number, wg: number, wb: number, wa: number
): number {
  const dr = Math.abs(r1 - r2), dg = Math.abs(g1 - g2);
  const db = Math.abs(b1 - b2), da = Math.abs(a1 - a2);
  const total = wr + wg + wb + wa;
  return (dr * wr + dg * wg + db * wb + da * wa) / total;
}
