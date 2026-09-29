/**
 * The five brushes, as data.
 *
 * Everything the panel shows (name, tagline, sliders, materials) and everything
 * the engine needs to choose a model lives here, so the UI never hard-codes a
 * brush and a sixth brush is one entry.
 *
 * `mouse` is each brush's stand-in for pressure on a device that has none. It
 * is not decoration: it is what lets a mouse user feel the difference between
 * a soft airbrush, a technical pen and an ink brush.
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
      base: 0.72, speedInfluence: 0.3, speedRef: 2,
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
      base: 0.75, speedInfluence: 0.2, speedRef: 2,
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
    minSize: 0.5,
    maxSize: 24,
    defaultIntensity: 1,
    intensityLabel: "Opacity",
    smoothing: 0.12,
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
          base: 0.62, speedInfluence: 0.25, speedRef: 2,
          ramp: 0.6, rampFrom: 0.5, taper: 1, taperTo: 0.5,
        }),
      },
      {
        id: "ink",
        name: "Ink brush",
        mouse: mouse({
          base: 0.7, speedInfluence: 0.6, speedRef: 1.8,
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
      base: 0.66, speedInfluence: 0.3, speedRef: 2,
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
      base: 0.62, speedInfluence: 0.45, speedRef: 2,
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
];

export const BRUSH_IDS: readonly BrushId[] = BRUSHES.map((b) => b.id);

export function brushSpec(id: BrushId): BrushSpec {
  return BRUSHES.find((b) => b.id === id) ?? BRUSHES[0];
}

/** Every brush remembers its own size, intensity, material and angle. */
export function defaultBrushPrefs(): Record<BrushId, BrushPrefs> {
  const out = {} as Record<BrushId, BrushPrefs>;
  for (const b of BRUSHES) {
    out[b.id] = {
      size: b.defaultSize,
      intensity: b.defaultIntensity,
      material: b.defaultMaterial,
      angle: 0,
    };
  }
  return out;
}
