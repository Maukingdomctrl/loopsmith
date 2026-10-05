/**
 * The brushes, as data.
 *
 * Everything the panel shows (name, tagline, sliders, materials) and everything
 * the engine needs — the model, and how the brush responds to the hand
 * (`dynamics`, see dynamics.ts) — lives here, so the UI never hard-codes a
 * brush and a new one is one entry. The Marker and the Eraser are exactly
 * that: the soft model with their own dynamics, no code of their own.
 *
 * `mouse` is each brush's stand-in for pressure on a device that has none. It
 * is not decoration: it is what lets a mouse user feel the difference between
 * a soft airbrush, a technical pen and an ink brush.
 *
 * Speed only lightens a stroke a little, and only for a real flick (speedRef is
 * in canvas px per ms; ordinary mouse drawing runs at 1-3). Stronger speed
 * fading made every normal-speed mouse stroke come out pale grey.
 */

import type { BrushId, BrushPrefs, BrushSpec, MouseDynamics } from "./types";

const mouse = (m: Partial<MouseDynamics> & { base: number }): MouseDynamics => ({
  speedInfluence: 0,
  speedRef: 2,
  ramp: 0,
  rampFrom: 1,
  taper: 0,
  taperTo: 1,
  ...m,
});

export const BRUSHES: readonly BrushSpec[] = [
  {
    id: "softRound",
    name: "Soft Round",
    tagline: "Atmosphere, shading and blends",
    model: "soft",
    shape: "round",
    defaultSize: 14,
    minSize: 1,
    maxSize: 64,
    defaultIntensity: 0.8,
    intensityLabel: "Intensity",
    smoothing: 0.3,
    mouse: mouse({
      base: 0.92, speedInfluence: 0.1, speedRef: 6,
      ramp: 1.2, rampFrom: 0.3, taper: 1.5, taperTo: 0.35,
    }),
  },
  {
    id: "softRect",
    name: "Soft Rectangle",
    tagline: "Broad soft blocks and gradients",
    model: "soft",
    shape: "rect",
    defaultSize: 10,
    minSize: 2,
    maxSize: 40,
    defaultIntensity: 0.8,
    intensityLabel: "Intensity",
    hasAngle: true,
    aspect: 2.4,
    smoothing: 0.3,
    mouse: mouse({
      base: 0.92, speedInfluence: 0.1, speedRef: 6,
      ramp: 0.8, rampFrom: 0.5, taper: 1, taperTo: 0.5,
    }),
  },
  {
    id: "hardLine",
    name: "Hard Linework",
    tagline: "Precise, pressure-shaped lines",
    model: "hard",
    shape: "round",
    defaultSize: 2,
    // a 0.25 px line: the engine draws sub-pixel widths by exact coverage
    minSize: 0.125,
    maxSize: 24,
    defaultIntensity: 1,
    intensityLabel: "Opacity",
    smoothing: 0.3,
    // a mouse has no pressure, so the pen draws its full width, evenly
    mouse: mouse({ base: 1 }),
    materials: [
      {
        id: "pen",
        name: "Technical pen",
        mouse: mouse({ base: 1 }),
      },
      {
        id: "pencil",
        name: "Sharp pencil",
        mouse: mouse({
          base: 0.8, speedInfluence: 0.15, speedRef: 6,
          ramp: 0.6, rampFrom: 0.5, taper: 1, taperTo: 0.5,
        }),
      },
      {
        id: "ink",
        name: "Ink brush",
        mouse: mouse({
          base: 0.9, speedInfluence: 0.3, speedRef: 6,
          ramp: 1.5, rampFrom: 0.12, taper: 2.5, taperTo: 0.05,
        }),
      },
    ],
    defaultMaterial: "pen",
  },
  {
    id: "water",
    name: "Water",
    tagline: "Pigment carried by water",
    model: "water",
    shape: "round",
    defaultSize: 14,
    minSize: 3,
    maxSize: 64,
    defaultIntensity: 0.85,
    intensityLabel: "Pigment",
    smoothing: 0.3,
    mouse: mouse({
      base: 0.85, speedInfluence: 0.1, speedRef: 6,
      ramp: 0.5, rampFrom: 0.65, taper: 0,
    }),
  },
  {
    id: "texture",
    name: "Texture",
    tagline: "Grain that follows the stroke",
    model: "texture",
    shape: "round",
    defaultSize: 10,
    minSize: 2,
    maxSize: 64,
    defaultIntensity: 0.85,
    intensityLabel: "Density",
    smoothing: 0.25,
    mouse: mouse({
      base: 0.88, speedInfluence: 0.15, speedRef: 6,
      ramp: 0.8, rampFrom: 0.4, taper: 1, taperTo: 0.4,
    }),
    materials: [
      { id: "graphite", name: "Graphite" },
      { id: "charcoal", name: "Charcoal" },
      { id: "canvas", name: "Canvas" },
      { id: "paper", name: "Paper" },
      { id: "dry", name: "Dry brush" },
    ],
    defaultMaterial: "graphite",
  },
  {
    id: "marker",
    name: "Marker",
    tagline: "Flat chisel ink that layers where it overlaps",
    model: "soft",
    shape: "rect",
    defaultSize: 8,
    minSize: 1,
    maxSize: 40,
    defaultIntensity: 0.7,
    intensityLabel: "Ink",
    hasAngle: true,
    aspect: 2.6,
    smoothing: 0.3,
    mouse: mouse({ base: 0.95, ramp: 0.4, rampFrom: 0.75 }),
    dynamics: {
      // a felt tip lays most of its ink at the lightest touch…
      pressure: { from: 0.5, to: 1, gamma: 0.7 },
      // …keeps a firm edge however it is pressed…
      hardness: { from: 0.85, to: 0.85, gamma: 1 },
      // …and runs dry on a quick stroke
      opacity: { speed: { from: 1, to: 0.7, gamma: 1.2, ref: 6 } },
    },
  },
  {
    id: "eraser",
    name: "Eraser",
    tagline: "Lifts paint softly; press to clear",
    model: "soft",
    shape: "round",
    defaultSize: 12,
    minSize: 1,
    maxSize: 64,
    defaultIntensity: 1,
    intensityLabel: "Strength",
    smoothing: 0.3,
    erase: true,
    mouse: mouse({ base: 0.95, ramp: 0.6, rampFrom: 0.6 }),
    dynamics: {
      // a light touch already lifts a little
      pressure: { from: 0, to: 1, gamma: 0.75 },
      // firmer-edged than the airbrush, firmer still when pressed
      hardness: { from: 0.35, to: 0.6, gamma: 1 },
    },
  },
];

export const BRUSH_IDS: readonly BrushId[] = BRUSHES.map((b) => b.id);

/** Size slider step: fine enough to reach a brush's smallest size exactly. */
export function sizeStep(spec: BrushSpec): number {
  if (spec.minSize < 0.5) return spec.minSize;
  return spec.maxSize <= 32 ? 0.5 : 1;
}

/** A size for a slider label: two decimals below 1, one below 10. */
export function formatSize(s: number): string {
  return s < 1 ? s.toFixed(2) : s < 10 ? s.toFixed(1) : s.toFixed(0);
}

export function brushSpec(id: BrushId): BrushSpec {
  return BRUSHES.find((b) => b.id === id) ?? BRUSHES[0];
}

/** Every brush remembers its own size, intensity, material, angle and mode. */
export function defaultBrushPrefs(): Record<BrushId, BrushPrefs> {
  const out = {} as Record<BrushId, BrushPrefs>;
  for (const b of BRUSHES) {
    out[b.id] = {
      size: b.defaultSize,
      intensity: b.defaultIntensity,
      material: b.defaultMaterial,
      angle: 0,
      mode: "normal",
    };
  }
  return out;
}
