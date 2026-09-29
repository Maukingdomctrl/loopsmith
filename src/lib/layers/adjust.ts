/**
 * Adjustment layers: pure per-pixel colour functions.
 *
 * They run on straight (un-premultiplied) RGBA bytes, as `getImageData`
 * returns them, and never touch alpha. `amount` is the adjustment layer's
 * opacity: 0 leaves the pixels alone, 1 applies the full adjustment.
 * Everything is deterministic, so the view and the GIF export agree.
 */

import type { Adjustment, ColorBalanceTone } from "@/types/layer";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Per-channel lookup tables: the same curve for R, G and B. */
function brightnessContrastLut(brightness: number, contrast: number): Uint8ClampedArray {
  // Brightness bends the curve (black and white stay put, like Photoshop's
  // modern Brightness/Contrast); contrast steepens or flattens it around mid-grey.
  const gamma = Math.pow(2, (-brightness / 100) * 1.3);
  const c = contrast / 100;
  const slope = 1 + c; // ×2 at +100, flat grey at −100
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) {
    let v = Math.pow(i / 255, gamma);
    v = (v - 0.5) * slope + 0.5;
    lut[i] = Math.round(clamp01(v) * 255);
  }
  return lut;
}

/* ---------------- HSL ---------------- */

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** Writes [h, s, l] (each 0..1) into `out`. */
function rgbToHsl(r: number, g: number, b: number, out: number[]): void {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) {
    out[0] = 0; out[1] = 0; out[2] = l;
    return;
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  out[0] = h / 6; out[1] = s; out[2] = l;
}

/** Writes [r, g, b] (each 0..1) into `out`. */
function hslToRgb(h: number, s: number, l: number, out: number[]): void {
  if (s <= 0) {
    out[0] = out[1] = out[2] = l;
    return;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  out[0] = hue2rgb(p, q, h + 1 / 3);
  out[1] = hue2rgb(p, q, h);
  out[2] = hue2rgb(p, q, h - 1 / 3);
}

/* ---------------- colour balance ---------------- */

// GIMP's colour-balance transfer curves: how much each tone range owns a value.
// Scaled so +100 on mid-grey gives a strong tint, not a pure primary.
const CB_A = 0.25, CB_B = 0.333, CB_SCALE = 0.35;
const shadowsW = (v: number) => clamp01((v - CB_B) / -CB_A + 0.5) * CB_SCALE;
const midtonesW = (v: number) =>
  clamp01((v - CB_B) / CB_A + 0.5) * clamp01((v + CB_B - 1) / -CB_A + 0.5) * CB_SCALE;
const highlightsW = (v: number) => clamp01((v + CB_B - 1) / CB_A + 0.5) * CB_SCALE;

function colorBalanceLuts(
  s: ColorBalanceTone,
  m: ColorBalanceTone,
  h: ColorBalanceTone
): [Float32Array, Float32Array, Float32Array] {
  const luts: [Float32Array, Float32Array, Float32Array] = [
    new Float32Array(256), new Float32Array(256), new Float32Array(256),
  ];
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < 256; i++) {
      const v = i / 255;
      luts[c][i] = clamp01(
        v + (s[c] / 100) * shadowsW(v) + (m[c] / 100) * midtonesW(v) + (h[c] / 100) * highlightsW(v)
      );
    }
  }
  return luts;
}

/* ---------------- entry point ---------------- */

export function isIdentityAdjustment(a: Adjustment): boolean {
  switch (a.type) {
    case "brightnessContrast": return a.brightness === 0 && a.contrast === 0;
    case "hueSaturation": return a.hue === 0 && a.saturation === 0 && a.lightness === 0;
    case "colorBalance":
      return [...a.shadows, ...a.midtones, ...a.highlights].every((v) => v === 0);
  }
}

/** Apply `adj` in place to straight RGBA bytes. */
export function applyAdjustment(data: Uint8ClampedArray, adj: Adjustment, amount: number): void {
  const k = clamp01(amount);
  if (k <= 0 || isIdentityAdjustment(adj)) return;
  const n = data.length;
  const mix = (orig: number, v: number) => orig + (v - orig) * k;

  if (adj.type === "brightnessContrast") {
    const lut = brightnessContrastLut(adj.brightness, adj.contrast);
    for (let i = 0; i < n; i += 4) {
      if (data[i + 3] === 0) continue;
      data[i] = mix(data[i], lut[data[i]]);
      data[i + 1] = mix(data[i + 1], lut[data[i + 1]]);
      data[i + 2] = mix(data[i + 2], lut[data[i + 2]]);
    }
    return;
  }

  const hsl = [0, 0, 0];
  const rgb = [0, 0, 0];

  if (adj.type === "hueSaturation") {
    const dh = adj.hue / 360;
    const sat = adj.saturation / 100;
    // Positive saturation multiplies up to 4×, so greys stay grey.
    const satMul = sat >= 0 ? 1 + 3 * sat : 1 + sat;
    const light = adj.lightness / 100;
    for (let i = 0; i < n; i += 4) {
      if (data[i + 3] === 0) continue;
      rgbToHsl(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255, hsl);
      let h = hsl[0] + dh;
      h -= Math.floor(h);
      hslToRgb(h, clamp01(hsl[1] * satMul), hsl[2], rgb);
      for (let c = 0; c < 3; c++) {
        // Lightness fades toward white or black, as in Photoshop.
        let v = rgb[c];
        v = light >= 0 ? v + (1 - v) * light : v * (1 + light);
        data[i + c] = mix(data[i + c], v * 255);
      }
    }
    return;
  }

  // Colour balance, luminosity preserved (Photoshop's default).
  const luts = colorBalanceLuts(adj.shadows, adj.midtones, adj.highlights);
  for (let i = 0; i < n; i += 4) {
    if (data[i + 3] === 0) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    rgbToHsl(r / 255, g / 255, b / 255, hsl);
    const l0 = hsl[2];
    rgbToHsl(luts[0][r], luts[1][g], luts[2][b], hsl);
    hslToRgb(hsl[0], hsl[1], l0, rgb);
    data[i] = mix(r, rgb[0] * 255);
    data[i + 1] = mix(g, rgb[1] * 255);
    data[i + 2] = mix(b, rgb[2] * 255);
  }
}
