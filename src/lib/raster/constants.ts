/**
 * Every numeric constant in the raster subsystem.
 *
 * Same rule as lib/lsa/constants.ts: nothing outside this file may contain a
 * bare tuning value, so the whole subsystem's behaviour is auditable from one
 * screen.
 */

import type { BrushSettings, DynamicCurve, RGBA, ShapeStyle } from "@/types/raster";

/* ---------- surface ---------- */

/** Channels in the internal float store. RGBA, premultiplied. */
export const CHANNELS = 4;

/**
 * Coverage below this is treated as zero.
 *
 * At 1/1020 it is half of one 8-bit quantum, so discarding it can never change
 * the committed byte — but it lets the stamp loop skip ~60% of the pixels in a
 * soft brush's bounding box.
 */
export const COVERAGE_EPSILON = 1 / 1020;

/** Alpha below this is snapped to fully transparent on commit, so that erased
 *  regions read as exactly 0 rather than as 1e-7 of a stale colour. */
export const ALPHA_SNAP = 1 / 510;

/** Hard cap on a single surface edge. Matches CANVAS_SIZE; anything larger is
 *  a corrupt layer size, and allocating from it would be an OOM vector. */
export const MAX_SURFACE_EDGE = 4096;

/* ---------- stamp rasterization ---------- */

/**
 * Supersampling grid for stamps whose radius is below SUPERSAMPLE_RADIUS.
 *
 * A 1.5 px brush evaluated at pixel centres aliases badly — the stroke visibly
 * pulses as it crosses pixel boundaries. 4×4 ordered sampling costs 16× on
 * a handful of pixels and removes it entirely. Ordered, not stochastic, so the
 * output stays deterministic.
 */
export const SUPERSAMPLE = 4;
export const SUPERSAMPLE_RADIUS = 3;

/** Analytic antialias band width for hard edges, in px. One pixel is the
 *  Nyquist-correct value for a box reconstruction filter. */
export const EDGE_AA_WIDTH = 1;

/** Extra margin added to every stamp's bounding box, in px. Covers the AA band
 *  plus float slop; too small and hard brushes lose their outermost row. */
export const STAMP_PADDING = 2;

/* ---------- stroke path ---------- */

/** Subdivisions per Bézier segment when building the arc-length LUT. 24 keeps
 *  the length error below 1e-4 px for segments up to ~200 px. */
export const ARCLEN_SUBDIVISIONS = 24;

/** Newton refinements after the LUT binary search. Two is enough to reach
 *  1e-6 px, which is far below the spacing quantum. */
export const ARCLEN_NEWTON_ITERS = 2;

/** Samples closer than this are merged: they carry no new direction
 *  information and produce degenerate tangents. */
export const MIN_SAMPLE_DISTANCE = 0.05;

/** Lower bound on stamp spacing, in px. Below this the stamp count explodes
 *  with no visible change. */
export const MIN_SPACING_PX = 0.25;

/** Fraction of diameter. Enforced so a user-set spacing of 0 cannot hang. */
export const MIN_SPACING_FRACTION = 0.01;
export const MAX_SPACING_FRACTION = 4;

/** Reference speed for `sizeBySpeed`, local px per ms. ~1.5 px/ms is a brisk
 *  but controlled stroke on a 512 px canvas. */
export const SPEED_REFERENCE = 1.5;

/** Time constant of the velocity estimate, ms. Raw per-event speed is far too
 *  noisy to drive size. Defined in time rather than per event, so a 60 Hz
 *  device reaches the hand's speed as quickly as a 240 Hz one (a per-event pole
 *  took a 60 Hz stroke a hundred pixels to "get up to speed"). 8 ms matches the
 *  old per-event 0.6 at 240 Hz. */
export const SPEED_SMOOTHING_MS = 8;

/** Width (σ, ms) of the zero-lag pressure smoothing between neighbouring
 *  samples. Digitizers report slightly noisy pressure; a causal low-pass would
 *  fix that only by making the stroke swell late — by several pixels on a
 *  quick stroke from a fast-reporting pen. Weights fall off with the time
 *  between samples, so a 60 Hz device is left essentially unsmoothed. */
export const PRESSURE_SMOOTHING_MS = 3;

/** Input smoothing: maximum fraction of the way a sample is pulled toward the
 *  running average at smoothing = 1. Capped below 1 so the stroke can never
 *  stop tracking the pointer entirely. */
export const MAX_INPUT_SMOOTHING = 0.85;

/** Pointer step, in CANVAS px, at which input smoothing has eased to half its
 *  strength. Jitter and mouse steps are about a pixel; a hand moving two or
 *  more pixels per sample is drawing, and is followed rather than averaged —
 *  otherwise a quick curve is cut short by the filter's lag. */
export const SMOOTHING_RELEASE = 2;

/** Catmull-Rom knot exponent. 0.5 = centripetal: provably free of cusps and
 *  self-intersections within a segment (Yuksel et al.), which uniform CR is
 *  not — uniform overshoots on sharp direction changes and produces the
 *  characteristic "loop" artifact at stroke corners. */
export const CURVE_ALPHA_CENTRIPETAL = 0.5;

/** Guard for coincident control points when computing knot spacing. */
export const KNOT_EPSILON = 1e-9;

/* ---------- pressure ---------- */

/**
 * A pen reading at or below this is no pressure at all: some pens report a
 * sliver of pressure on their first sample. Whether a device's pressure is
 * real in the first place (mice and trackpads report 0.5 while down) is the
 * input layer's call, from evidence (lib/input).
 */
export const PRESSURE_EPSILON = 1e-4;

/* ---------- flood fill ---------- */

/** Explicit span stack initial capacity. Grown geometrically; never recursive,
 *  because a 512×512 fill would blow the JS stack. */
export const FILL_STACK_INITIAL = 1024;

/** Hard iteration cap. A malformed tolerance cannot lock the tab. */
export const FILL_MAX_SPANS = 1 << 22;

/** Weights for the RGBA distance metric. Alpha is weighted highest because an
 *  alpha edge is a hard boundary to the eye even when the colours match. */
export const FILL_WEIGHT_R = 0.299;
export const FILL_WEIGHT_G = 0.587;
export const FILL_WEIGHT_B = 0.114;
export const FILL_WEIGHT_A = 1.0;

export const MAX_FILL_GROW = 32;
export const MAX_FILL_FEATHER = 32;

/* ---------- shapes ---------- */

export const MIN_SHAPE_SIZE = 0.5;
export const DEFAULT_ARROW_HEAD_LENGTH = 18;
export const DEFAULT_ARROW_HEAD_WIDTH = 11;

/* ---------- defaults ---------- */

const linear = (min: number, max: number, gamma = 1): DynamicCurve =>
  ({ min, max, gamma });

export const NO_DYNAMIC: DynamicCurve = linear(1, 1, 1);

export const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };

export const DEFAULT_BRUSH: BrushSettings = {
  radius: 8,
  hardness: 0.85,
  flow: 1,
  opacity: 1,
  spacing: 0.1,
  shape: "round",
  aspect: 1,
  angle: 0,
  followTangent: false,
  accumulation: "wet",
  blend: "normal",
  sizeByPressure: linear(0.25, 1, 1),
  flowByPressure: NO_DYNAMIC,
  sizeBySpeed: NO_DYNAMIC,
  scatter: 0,
  sizeJitter: 0,
  seed: 1,
  color: BLACK,
  smoothing: 0.4,
  curveAlpha: CURVE_ALPHA_CENTRIPETAL,
};

export const DEFAULT_ERASER: BrushSettings = {
  ...DEFAULT_BRUSH,
  hardness: 0.95,
  // Erasers accumulate, so dwelling on a spot fully clears it. A "wet" eraser
  // would cap at `opacity` and leave a permanent ghost no matter how long you
  // scrub, which reads as a broken tool.
  accumulation: "buildup",
};

export const DEFAULT_SHAPE_STYLE: ShapeStyle = {
  fill: null,
  stroke: BLACK,
  strokeWidth: 2,
  cornerRadius: 0,
  opacity: 1,
  blend: "normal",
  antialias: EDGE_AA_WIDTH,
};

/* ---------- deterministic PRNG ---------- */

/**
 * xorshift32. Chosen over Math.random for one reason: determinism. Jitter must
 * replay identically, or an undone-and-redone stroke changes its pixels and
 * the flatten cache, which in turn marks a good stabilization solve stale.
 */
export function createRandom(seed: number): () => number {
  let s = (seed | 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5;  s |= 0;
    return ((s >>> 0) / 0x100000000);
  };
}

/** Apply a dynamic curve to a 0..1 input. */
export function applyCurve(input: number, c: DynamicCurve): number {
  const t = input <= 0 ? 0 : input >= 1 ? 1 : input;
  const g = c.gamma === 1 ? t : Math.pow(t, c.gamma);
  return c.min + (c.max - c.min) * g;
}
