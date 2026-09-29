/**
 * Types for the material brush system.
 *
 * ONE ENGINE, FIVE MATERIALS. Every brush is driven by the same machinery:
 *
 *     samples → StrokePath (C¹ curve, arc-length resampling, sub-pixel exact)
 *             → BrushInput  (what the brush "feels" at that point)
 *             → BrushModel  (how a material reacts to it)
 *             → material buffers → composite
 *
 * `BrushInput` is the whole contract between the stroke and a material. A model
 * never sees a pointer event, a canvas or a React component: only a point on the
 * curve and what the hand was doing there.
 */

import type { Vec2, Rect } from "@/types/geometry";
import type { RGBA } from "@/types/raster";
import type { RasterSurface } from "../surface";
import type { DirtyTracker } from "../surface";

export type BrushId = "softRound" | "softRect" | "hardLine" | "water" | "texture";

/** Footprint family. Both are analytic distance fields — never bitmaps. */
export type FootprintShape = "round" | "rect";

/** Which material model interprets the stroke. */
export type ModelKind = "soft" | "hard" | "water" | "texture";

/* ------------------------------------------------------------------ */
/*  what a brush receives at every point of a stroke                   */
/* ------------------------------------------------------------------ */

export interface BrushInput {
  /** Position on the curve, layer px, sub-pixel. */
  readonly x: number;
  readonly y: number;
  /**
   * 0..1, continuous. A pen reports it; for a mouse it is synthesized from
   * hand speed and the start/end of the stroke (see `MouseDynamics`), so a
   * brush never has to special-case the input device.
   */
  readonly pressure: number;
  /** Canvas px per ms, smoothed. Measured on screen, so a zoomed-out layer does
   *  not make the same hand movement look "fast". */
  readonly velocity: number;
  /** ms since the stroke began. */
  readonly time: number;
  /** 0 = pen perpendicular to the surface … 1 = lying flat. */
  readonly tilt: number;
  /** Direction the pen leans toward, radians. */
  readonly azimuth: number;
  /** Footprint orientation, radians: user angle (+ stroke direction and pen
   *  barrel rotation where the brush asks for them). */
  readonly rotation: number;
  /** Unit tangent of the path. */
  readonly tangent: Vec2;
  /** Arc length from the stroke origin, layer px. */
  readonly distance: number;
  /** Arc length and time since the previous dab. Deposits are weighted by
   *  these, so density does not depend on how densely the dabs are placed. */
  readonly ds: number;
  readonly dt: number;
  /** User brush radius, layer px. */
  readonly size: number;
  /** True for the first dab of the stroke. */
  readonly first: boolean;
  /** Arc length left before the stroke ends. Infinity while the stroke is
   *  still live; only known once the pen has lifted. */
  readonly remaining: number;
}

/* ------------------------------------------------------------------ */
/*  models                                                             */
/* ------------------------------------------------------------------ */

/** Everything a material is told once, when the stroke begins. */
export interface ModelContext {
  readonly width: number;
  readonly height: number;
  /**
   * The canvas surface as it was before the stroke — the previous pigment /
   * material state. Premultiplied float RGBA. Read-only by convention.
   */
  readonly baseline: Float32Array;
  readonly color: RGBA;
  /** The opacity / intensity slider, 0..1. */
  readonly intensity: number;
  /** Selected material variant id ("" when the brush has none). */
  readonly material: string;
  readonly seed: number;
  /** User brush radius, layer px. */
  readonly size: number;
  /** Layer px → canvas px. */
  readonly scale: number;
  /** Fixed footprint angle, radians (rectangular brush). */
  readonly angle: number;
  readonly shape: FootprintShape;
  /** Rectangle half-width ÷ half-height. */
  readonly aspect: number;
}

export interface BrushModel {
  /** Arc length to travel before the next dab, layer px. */
  spacing(input: BrushInput): number;
  /** Deposit material for one dab. */
  dab(input: BrushInput): void;
  /** The pen has lifted: let time-dependent physics (drying) run to the end. */
  settle(): void;
  /**
   * Pixels whose composite result changed since the stroke last read this.
   * The stroke resets it after every preview, so previews only ever touch
   * what actually moved.
   */
  readonly dirty: DirtyTracker;
  /**
   * Composite the material over `target` inside `region`. `target` must hold
   * the pre-stroke pixels there; the result is exactly what commit will write.
   */
  composite(target: RasterSurface, region: Rect): void;
}

/* ------------------------------------------------------------------ */
/*  presets                                                            */
/* ------------------------------------------------------------------ */

/** How a device without pressure (mouse, touch) stands in for one. */
export interface MouseDynamics {
  /** The pressure a plain press stands for. */
  readonly base: number;
  /** 0..1: how much a fast stroke lightens. */
  readonly speedInfluence: number;
  /** Canvas px/ms at which the lightening is complete. */
  readonly speedRef: number;
  /** Touch-down ramp length, in brush radii. 0 = none. */
  readonly ramp: number;
  /** Fraction of `base` at the very first dab. */
  readonly rampFrom: number;
  /** End taper length, in brush radii. 0 = none. */
  readonly taper: number;
  /** Fraction of pressure left at the very end. */
  readonly taperTo: number;
}

export interface BrushMaterial {
  readonly id: string;
  readonly name: string;
  /** Overrides the brush's mouse recipe: a technical pen wants none of the
   *  speed and taper behaviour an ink brush is made of. */
  readonly mouse?: MouseDynamics;
}

export interface BrushSpec {
  readonly id: BrushId;
  readonly name: string;
  /** One line, shown under the name in the panel. */
  readonly tagline: string;
  readonly model: ModelKind;
  readonly shape: FootprintShape;
  /** Radius in canvas px. */
  readonly defaultSize: number;
  readonly minSize: number;
  readonly maxSize: number;
  readonly defaultIntensity: number;
  /** Label of the second slider. */
  readonly intensityLabel: string;
  /** Footprint angle offered as a slider (rectangular brush only). */
  readonly hasAngle?: boolean;
  /** Rectangle half-width ÷ half-height. */
  readonly aspect?: number;
  readonly materials?: readonly BrushMaterial[];
  readonly defaultMaterial?: string;
  /** Input smoothing handed to StrokePath. */
  readonly smoothing: number;
  readonly mouse: MouseDynamics;
}

/** The user's settings for one brush. Size is a radius in canvas px, angle in degrees. */
export interface BrushPrefs {
  readonly size: number;
  readonly intensity: number;
  readonly material?: string;
  readonly angle: number;
}

/** What the stroke needs to start. */
export interface MaterialStrokeOptions {
  readonly brush: BrushSpec;
  readonly color: RGBA;
  /** Brush radius, layer px. */
  readonly radius: number;
  /** 0..1 */
  readonly intensity: number;
  readonly material?: string;
  /** Footprint angle, radians. */
  readonly angle?: number;
  /** True when the device reports real pressure (a pen). */
  readonly hasPressure: boolean;
  /** Layer px → canvas px, used to measure hand speed on screen. */
  readonly scale?: number;
  readonly seed?: number;
  /** Alpha lock: only recolour pixels the layer already has. */
  readonly lockAlpha?: boolean;
}

/** The mouse recipe in force: the selected material's, else the brush's. */
export function resolveMouse(spec: BrushSpec, material?: string): MouseDynamics {
  const m = spec.materials?.find((x) => x.id === (material ?? spec.defaultMaterial));
  return m?.mouse ?? spec.mouse;
}
