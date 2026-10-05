/**
 * Types of the input layer: what a pointer reports, and what the engine has
 * learned about the device that reports it.
 *
 * The input layer sits between the browser's pointer events and the stroke
 * model. It owns everything that depends on the DEVICE — reading every channel
 * the platform exposes, learning what the device can and cannot report, and
 * compensating measured weaknesses — so nothing downstream (stroke path,
 * dynamics, materials, rasterizer) ever needs to know which pen drew a stroke.
 *
 *   PointerEvent → read (adapter.ts) → evidence (capabilities.ts)
 *                → calibration (calibration.ts) → normalized sample
 *                (pipeline.ts) → StrokePath / pencil record
 *
 * plus one number for the stroke model: how widely to average pressure
 * between neighbouring samples for this device (pipeline.ts).
 */

export type PointerKind = "pen" | "touch" | "mouse";

/**
 * One pointer sample, every channel the platform reported, read once.
 * Reused in place by the adapter: copy what you keep.
 */
export interface PenSample {
  /** Layer px, sub-pixel, exactly as the canvas maps the pointer. */
  x: number;
  y: number;
  /** Client (CSS) px as reported, for the evidence on position resolution. */
  clientX: number;
  clientY: number;
  /** ms, strictly increasing within a stroke (see `TimeRepair`). */
  time: number;
  /** As reported, 0..1 (mice and pressure-less devices report 0.5 / 0 / 1). */
  pressure: number;
  /** Radians from the surface normal: 0 = upright. 0 when unsupported. */
  tilt: number;
  /** Direction the pen leans toward, radians, in LAYER space. 0 when upright. */
  azimuth: number;
  /** Direction the pen leans toward on screen, radians (evidence only). */
  screenAzimuth: number;
  /** Barrel rotation, radians. 0 when unsupported. */
  twist: number;
  /** Contact geometry, CSS px. 1 × 1 (or 0 × 0) when unsupported. */
  width: number;
  height: number;
  /** Airbrush finger wheel, −1..1. 0 when unsupported. */
  tangential: number;
}

export function createPenSample(): PenSample {
  return {
    x: 0, y: 0, clientX: 0, clientY: 0, time: 0, pressure: 0, tilt: 0, azimuth: 0,
    screenAzimuth: 0, twist: 0, width: 1, height: 1, tangential: 0,
  };
}

/**
 * What the engine knows about a device, from what it has actually reported —
 * never from its brand or what its hardware could do. A snapshot: frozen when
 * a stroke begins, so one stroke is processed one way from start to end and
 * the same input with the same history always draws the same pixels.
 */
export interface DeviceProfile {
  readonly kind: PointerKind;
  /** Strokes the evidence comes from (a rolling window). */
  readonly strokes: number;
  /**
   * real: pressure varies in contact. none: it never does (a mouse, or a pen or
   * finger that only reports the spec's 0.5 / 0 / 1). unknown: not seen yet.
   */
  readonly pressure: "real" | "none" | "unknown";
  /**
   * Quantization step of the reported pressure: 1 / levels. 0 when values are
   * continuous (finer than 1 / 16384, or on no lattice).
   */
  readonly pressureStep: number;
  /**
   * Noise on the reported pressure beyond its quantization, as σ (pressure
   * units). 0 unless it is clearly measurable (see `capabilities.ts`).
   */
  readonly pressureNoise: number;
  /** Lowest pressure the device reports in contact, when it has a floor it
   *  never goes below (0 = none). */
  readonly floor: number;
  /** Highest pressure it can report, when it saturates below 1 (1 = none). */
  readonly ceiling: number;
  /** Channels it has been seen to report. */
  readonly tilt: boolean;
  readonly twist: boolean;
  readonly contact: boolean;
  /** Fractional client coordinates seen (false: positions on a whole-px grid). */
  readonly subpixel: boolean;
  /** Median report rate of its samples, Hz (0 = unknown). */
  readonly rateHz: number;
  /** Smallest step between distinct timestamps, ms (0 = unknown). */
  readonly timeStep: number;
  /** A summary for diagnostics only: nothing branches on it. */
  readonly tier: "premium" | "standard" | "basic" | "none" | "unknown";
}

/** The profile of a device nothing is known about yet: trust what it reports. */
export function unknownProfile(kind: PointerKind): DeviceProfile {
  return {
    kind,
    strokes: 0,
    pressure: kind === "mouse" ? "none" : "unknown",
    pressureStep: 0,
    pressureNoise: 0,
    floor: 0,
    ceiling: 1,
    tilt: false,
    twist: false,
    contact: false,
    subpixel: true,
    rateHz: 0,
    timeStep: 0,
    tier: kind === "mouse" ? "none" : "unknown",
  };
}
