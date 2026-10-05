/**
 * One stroke's input: pointer events in, normalized samples out.
 *
 *   1. read       every channel of every coalesced event (adapter.ts)
 *   2. time       timestamps made strictly increasing (adapter.ts TimeRepair)
 *   3. evidence   the samples, as reported, feed the device's tracker
 *                 (capabilities.ts); it judges the device once the pen lifts
 *   4. pressure   real or not — decided once, at pen-down
 *   5. calibrate  floor / ceiling / response (calibration.ts; identity unless
 *                 the evidence or a curve asks for more)
 *
 * What a device's pressure cannot resolve — a coarse lattice (256 levels
 * arrive as a staircase) or noise — is not filtered here: anything causal
 * lags, and a model-based reconstruction measurably made terraces worse once
 * a hand's real tremor was in the signal (docs/brush-dynamics.md). Instead the
 * stroke model, which already holds one sample back to build its curve,
 * averages each sample's pressure with both neighbours — symmetric, so
 * without lag or overshoot — and for such a device it is told to average
 * more, but only across differences the device's uncertainty explains, so a
 * real fast change of pressure passes untouched (`pressureFilterFor`).
 *
 * Everything that depends on the device is fixed for the stroke when it
 * begins: the profile is a snapshot, so a stroke is processed one way from
 * start to end, and the same input after the same history always gives the
 * same samples. Nothing here touches the DOM or React; it is called from the
 * pointer handlers with events the browser has already delivered.
 */

import type { StrokeSample } from "@/types/raster";
import { PRESSURE_EPSILON, PRESSURE_SMOOTHING_MS } from "@/lib/raster/constants";
import type { PressureCurve } from "@/lib/raster/brushes/curves";
import { readPointer, TimeRepair, type PointerLike, type PointerMapping } from "./adapter";
import type { CapabilityTracker } from "./capabilities";
import { calibrate, calibrationFor, type PressureCalibration } from "./calibration";
import { createPenSample, type DeviceProfile, type PenSample, type PointerKind } from "./types";

/**
 * Whether a stroke has real pressure, decided at pen-down. A pen does, unless
 * its evidence says it only ever reports the spec's stand-in values. A finger
 * or a stylus the browser calls "touch" does when its first report is a real
 * reading (not 0, 0.5 or 1) and the evidence does not contradict it. A mouse
 * never does.
 */
export function strokeHasPressure(kind: PointerKind, firstPressure: number, profile: DeviceProfile): boolean {
  if (profile.pressure === "none") return false;
  if (kind === "pen") return true;
  if (kind === "touch") return firstPressure > 0 && firstPressure < 1 && firstPressure !== 0.5;
  return false;
}

/** A lattice this coarse (fewer than ~600 levels) shows as terraces on a
 *  large brush; finer ones (1024 levels through Windows Ink, 4096 on many
 *  Android pens) are left exactly as they are (brush:check §13). */
const COARSE_STEP = 1 / 600;

/** Neighbours are averaged across differences up to about this many σ of
 *  the device's pressure uncertainty. */
const RANGE_SIGMAS = 4;

/** How the stroke model averages pressure between neighbouring samples. */
export interface PressureFilter {
  /** σ in time, ms (lib/raster/stroke.ts). */
  readonly smoothing: number;
  /** σ of the pressure difference averaged across; 0 = any. */
  readonly range: number;
}

/**
 * The averaging a device calls for. One whose pressure is measurably
 * uncertain — noisy, or on a coarse lattice — gets a width in time of its
 * own report interval (both neighbours weigh up to 0.6) and a range in
 * pressure of its uncertainty, √(σ² + Δ²/12): a steady stroke's noise and a
 * swell's one-level steps are averaged away, a deliberate quick change of
 * pressure is not. Every other device keeps the model's own width and no
 * range — exactly the arithmetic it had before.
 */
export function pressureFilterFor(profile: DeviceProfile): PressureFilter {
  const step = profile.pressureStep >= COARSE_STEP ? profile.pressureStep : 0;
  const uncertainty = Math.sqrt(profile.pressureNoise ** 2 + (step * step) / 12);
  if (!(uncertainty > 0) || !(profile.rateHz > 0)) return { smoothing: PRESSURE_SMOOTHING_MS, range: 0 };
  return {
    smoothing: Math.max(PRESSURE_SMOOTHING_MS, 1000 / profile.rateHz),
    range: RANGE_SIGMAS * uncertainty,
  };
}

export class StrokeInput {
  readonly kind: PointerKind;
  readonly profile: DeviceProfile;
  readonly hasPressure: boolean;
  readonly calibration: PressureCalibration;
  /** How the stroke model should average this device's pressure. */
  readonly pressureFilter: PressureFilter;

  private readonly tracker: CapabilityTracker | null;
  private readonly repair = new TimeRepair();
  private pool: PenSample[] = [];
  private times = new Float64Array(32);
  /** The last real reading, standing in for a report that is not a number. */
  private lastPressure = 0.5;
  private ended = false;

  /**
   * @param tracker  Where this stroke's evidence goes; null to process input
   *                 without learning from it (previews, replays, tests).
   * @param response An optional pressure response curve (identity when null).
   */
  constructor(
    kind: PointerKind,
    profile: DeviceProfile,
    firstPressure: number,
    tracker: CapabilityTracker | null,
    response: PressureCurve | null = null
  ) {
    this.kind = kind;
    this.profile = profile;
    this.hasPressure = strokeHasPressure(kind, firstPressure, profile);
    this.calibration = calibrationFor(profile, response);
    this.pressureFilter = this.hasPressure
      ? pressureFilterFor(profile)
      : { smoothing: PRESSURE_SMOOTHING_MS, range: 0 };
    this.tracker = tracker;
    tracker?.beginStroke();
  }

  /**
   * Process the samples one event delivered together — a pointer event's
   * coalesced samples, or the pen-down on its own — calling `emit` with each
   * one that maps into the layer, in order. The sample passed to `emit` is
   * reused: copy what you keep.
   */
  push(events: ArrayLike<PointerLike>, map: PointerMapping, emit: (s: PenSample) => void): void {
    if (this.ended) return;
    const n = events.length;
    while (this.pool.length < n) this.pool.push(createPenSample());
    if (this.times.length < n) this.times = new Float64Array(n * 2);
    const pool = this.pool, times = this.times;

    let m = 0;
    for (let i = 0; i < n; i++) {
      // a sample that cannot be mapped is dropped; the next one takes its slot
      if (readPointer(events[i], map, pool[m])) times[m] = pool[m++].time;
    }
    this.repair.batch(times, m);
    for (let k = 0; k < m; k++) {
      const s = pool[k];
      const reported = s.time;
      s.time = times[k];
      this.tracker?.observe(s, reported);
      s.pressure = this.pressureOf(s.pressure);
      emit(s);
    }
  }

  /** Reported → calibrated pressure (only for real pressure). */
  private pressureOf(reported: number): number {
    if (!this.hasPressure) return reported;
    let p = reported;
    if (!Number.isFinite(p)) p = this.lastPressure;
    else p = p < 0 ? 0 : p > 1 ? 1 : p;
    this.lastPressure = p;
    return calibrate(p, this.calibration);
  }

  /** The pen has lifted (or the stroke was cancelled): the evidence is complete. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.tracker?.endStroke();
  }
}

/**
 * A sample as the stroke model takes it (lib/raster/stroke.ts). Pressure is
 * the stroke's real pressure, with a reading at the noise floor taken as none
 * (some pens report a sliver of pressure on the first sample), or 1 for a
 * device without pressure, whose brush simulates it instead. A pen held
 * upright has no lean direction.
 */
export function strokeSample(s: PenSample, hasPressure: boolean): StrokeSample {
  const p = s.pressure;
  return {
    x: s.x,
    y: s.y,
    pressure: hasPressure ? (p <= PRESSURE_EPSILON ? 0 : Math.min(1, p)) : 1,
    tilt: s.tilt,
    twist: s.twist,
    time: s.time,
    azimuth: s.tilt === 0 ? 0 : s.azimuth,
  };
}
