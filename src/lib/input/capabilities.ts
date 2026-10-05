/**
 * What a device can actually report, learned from what it has reported.
 *
 * A pen's brand says little about what reaches the page: the same Wacom pen
 * reports 1024 pressure levels through Windows Ink, 8192 through another
 * driver, no tilt in one browser and tilt in the next. So nothing here looks
 * at names. Every capability is EVIDENCE gathered from the samples of the last
 * strokes, and every weakness is a measured property with a number on it:
 *
 *   pressure     real (varies in contact) or none (only the spec's 0.5/0/1)
 *   step         the lattice reported pressures lie on: 1/1024 on Windows Ink,
 *                1/4096 on many Android pens, 0 for continuous ones
 *   noise        jitter on top of that lattice, when it is clearly there
 *   floor        a lowest value the device never reports below in contact
 *   ceiling      a highest value it saturates at, when below 1
 *   channels     tilt, twist, contact size, sub-pixel position
 *   rate         how often it reports (coalesced samples), and time resolution
 *
 * The verdicts are deliberately conservative. A compensation that fires on a
 * good pen degrades it, while one that fails to fire on a weak pen only leaves
 * it as it is today; so each verdict needs a margin of evidence, and the
 * profile of a device nothing is known about trusts it completely.
 *
 * Evidence lives in fixed-size rolling buffers (no allocation per sample); the
 * analysis runs once per stroke, when the pen lifts, never on a pointer move.
 */

import type { DeviceProfile, PenSample, PointerKind } from "./types";
import { unknownProfile } from "./types";

/* ---------- how much evidence each verdict needs ---------- */

/** Strokes in the rolling window. A new device takes over within this many. */
const WINDOW_STROKES = 24;
/** Recent in-contact pressures kept for the lattice and the ceiling. */
const PRESSURE_CAP = 2048;
/** Recent sample intervals kept for the report rate. */
const INTERVAL_CAP = 512;
/** Recent second differences kept for the noise estimate. */
const D2_CAP = 1024;

/** Distinct pressures needed before a lattice is believed. */
const LATTICE_MIN_DISTINCT = 24;
/** Lattices finer than this are continuous for every purpose here. */
const MAX_LEVELS = 16384;
/** How far (in levels) a value may sit from its lattice point: float32 rounding
 *  of level/N is ~1e-4 levels; anything near this is not a lattice. */
const LATTICE_TOLERANCE = 0.02;

/** A floor below this is not worth compensating (a whisper is still a line). */
const FLOOR_MIN = 0.02;
/** Strokes with real pressure needed before a floor is believed. */
const FLOOR_MIN_STROKES = 8;
/** Share of touch-downs and lift-offs that must land near the floor. */
const FLOOR_BOUNDARY_SHARE = 0.6;

/** A ceiling must be clearly short of full pressure… */
const CEILING_MAX = 0.98;
/** …be run into and held by at least this many strokes, and this share… */
const CEILING_MIN_CLIPPED = 3;
const CEILING_CLIPPED_SHARE = 0.15;
/** …and stand out: the top value this many times as common as all the values
 *  just below it together. A sensor at its limit piles up on one value; a
 *  hand holding a firm, steady pressure wavers across several. */
const CEILING_SPIKE = 3;

/** Noise is only judged on devices fast enough to tell it from the hand. */
const NOISE_MIN_RATE = 100;
/** Second differences needed for a noise estimate. */
const NOISE_MIN_SAMPLES = 256;
/** Share of successive pressure changes that reverse direction. White noise
 *  reverses about 2 in 3; a hand's smooth pressure almost never does. */
const NOISE_MIN_ZIGZAG = 0.45;
/** σ below this is left alone: the stroke model's own zero-lag smoothing
 *  already absorbs it (lib/raster/stroke.ts, PRESSURE_SMOOTHING_MS). */
const NOISE_MIN_SIGMA = 0.0015;

/** Lean below this (radians, ~0.6°) is a pen held upright, not tilt support. */
const TILT_EVIDENCE = 0.01;

/* ---------- per-stroke evidence ---------- */

export interface StrokeStats {
  samples: number;
  first: number;
  last: number;
  min: number;
  max: number;
  /** Samples at exactly `max`. */
  atMax: number;
  /** Every sample reported the same pressure. */
  constant: boolean;
}

const newStats = (): StrokeStats => ({ samples: 0, first: 0, last: 0, min: Infinity, max: -Infinity, atMax: 0, constant: true });

/**
 * Evidence for one kind of pointer. Feed it every sample of every stroke;
 * read `profile` when a stroke begins.
 */
export class CapabilityTracker {
  readonly kind: PointerKind;
  private cached: DeviceProfile;

  private readonly strokes: StrokeStats[] = [];
  private strokeHead = 0;
  private current: StrokeStats | null = null;

  private readonly pressures = new Float64Array(PRESSURE_CAP);
  private pressureCount = 0;
  private pressureHead = 0;

  private readonly intervals = new Float64Array(INTERVAL_CAP);
  private intervalCount = 0;
  private intervalHead = 0;
  private minRawStep = Infinity;

  private readonly d2 = new Float64Array(D2_CAP);
  private d2Count = 0;
  private d2Head = 0;
  private zigzag = 0;
  private zigzagPairs = 0;

  private sawTilt = false;
  private sawTwist = false;
  private sawContact = false;
  private sawFraction = false;
  private wholeSamples = 0;

  /* the previous samples of the current stroke */
  private p1 = NaN; private p2 = NaN;
  private t1 = NaN; private t2 = NaN;
  private raw1 = NaN;
  private lastDelta = 0;

  constructor(kind: PointerKind) {
    this.kind = kind;
    this.cached = unknownProfile(kind);
  }

  /** The profile as of the last finished stroke. Cheap: computed at pen-up. */
  get profile(): DeviceProfile {
    return this.cached;
  }

  beginStroke(): void {
    this.current = newStats();
    this.p1 = this.p2 = this.t1 = this.t2 = this.raw1 = NaN;
    this.lastDelta = 0;
  }

  /**
   * One in-contact sample. `rawTime` is the timestamp as reported, before
   * `TimeRepair`: its resolution is evidence too.
   */
  observe(s: PenSample, rawTime: number): void {
    const st = this.current;
    if (!st) return;
    const p = s.pressure;
    if (Number.isFinite(p)) {
      if (st.samples === 0) st.first = p;
      else if (p !== st.last) st.constant = false;
      st.last = p;
      if (p < st.min) st.min = p;
      if (p > st.max) { st.max = p; st.atMax = 1; }
      else if (p === st.max) st.atMax++;
      st.samples++;
      this.pressures[this.pressureHead] = p;
      this.pressureHead = (this.pressureHead + 1) % PRESSURE_CAP;
      if (this.pressureCount < PRESSURE_CAP) this.pressureCount++;
    }

    if (s.tilt > TILT_EVIDENCE) this.sawTilt = true;
    if (s.twist !== 0) this.sawTwist = true;
    if (s.width > 1.5 || s.height > 1.5) this.sawContact = true;
    if (s.clientX !== Math.round(s.clientX) || s.clientY !== Math.round(s.clientY)) this.sawFraction = true;
    else this.wholeSamples++;

    // report rate and time resolution
    if (Number.isFinite(this.t1)) {
      const dt = s.time - this.t1;
      if (dt > 0 && dt < 100) {
        this.intervals[this.intervalHead] = dt;
        this.intervalHead = (this.intervalHead + 1) % INTERVAL_CAP;
        if (this.intervalCount < INTERVAL_CAP) this.intervalCount++;
      }
      const raw = rawTime - this.raw1;
      if (raw > 0 && raw < this.minRawStep) this.minRawStep = raw;
    }

    // noise: second differences over evenly spaced samples, and how often
    // successive changes reverse
    if (Number.isFinite(p) && Number.isFinite(this.p2)) {
      const dtA = this.t1 - this.t2, dtB = s.time - this.t1;
      if (dtA > 0 && dtB > 0 && Math.abs(dtA - dtB) <= 0.3 * Math.max(dtA, dtB)) {
        this.d2[this.d2Head] = Math.abs(this.p2 - 2 * this.p1 + p);
        this.d2Head = (this.d2Head + 1) % D2_CAP;
        if (this.d2Count < D2_CAP) this.d2Count++;
      }
    }
    if (Number.isFinite(p) && Number.isFinite(this.p1)) {
      const delta = p - this.p1;
      if (delta !== 0) {
        if (this.lastDelta !== 0) {
          this.zigzagPairs++;
          if ((delta > 0) !== (this.lastDelta > 0)) this.zigzag++;
        }
        this.lastDelta = delta;
      }
    }

    this.p2 = this.p1; this.t2 = this.t1;
    this.p1 = p; this.t1 = s.time; this.raw1 = rawTime;
  }

  /** The pen has lifted: fold the stroke into the window and re-derive the profile. */
  endStroke(): void {
    const st = this.current;
    this.current = null;
    if (!st || st.samples === 0) return;
    if (this.strokes.length < WINDOW_STROKES) this.strokes.push(st);
    else this.strokes[this.strokeHead] = st;
    this.strokeHead = (this.strokeHead + 1) % WINDOW_STROKES;
    this.cached = this.analyse();
  }

  private analyse(): DeviceProfile {
    const kind = this.kind;
    const strokes = this.strokes;
    const pressure = pressureVerdict(kind, strokes);

    const values = this.pressures.subarray(0, this.pressureCount);
    const step = pressure === "real" ? pressureLattice(values) : 0;
    const rateHz = medianRate(this.intervals.subarray(0, this.intervalCount));
    const noise = pressure === "real"
      ? pressureNoise(this.d2.subarray(0, this.d2Count), this.zigzagPairs ? this.zigzag / this.zigzagPairs : 0, step, rateHz)
      : 0;
    const floor = pressure === "real" ? pressureFloor(strokes) : 0;
    const ceiling = pressure === "real" ? pressureCeiling(strokes, values, step, floor) : 1;

    const profile = {
      kind,
      strokes: strokes.length,
      pressure,
      pressureStep: step,
      pressureNoise: noise,
      floor,
      ceiling,
      tilt: this.sawTilt,
      twist: this.sawTwist,
      contact: this.sawContact,
      // whole-pixel positions only count once there are enough of them
      subpixel: this.sawFraction || this.wholeSamples < 64,
      rateHz,
      timeStep: Number.isFinite(this.minRawStep) ? this.minRawStep : 0,
      tier: "unknown" as DeviceProfile["tier"],
    };
    return { ...profile, tier: tierOf(profile) };
  }
}

/* ---------- the verdicts, as pure functions (tested in brush:check) ---------- */

/** Pressure is real once it has varied within a stroke; none when stroke after
 *  stroke only ever reports one of the spec's stand-in values. */
export function pressureVerdict(kind: PointerKind, strokes: readonly StrokeStats[]): DeviceProfile["pressure"] {
  if (kind === "mouse") return "none";
  let constant = 0;
  for (const s of strokes) {
    if (s.samples < 3) continue;
    if (!s.constant) return "real";
    if (s.first === 0.5 || s.first === 0 || s.first === 1) constant++;
  }
  return constant >= 2 ? "none" : "unknown";
}

/**
 * The step of the lattice pressures lie on (1/N), or 0 when they lie on none
 * coarser than 1/16384.
 *
 * Drivers report level/N, which reaches the page as a float32. The smallest
 * gap between distinct values estimates 1/N (or a small multiple of it, when
 * neighbouring levels were never both seen); the candidate N near it whose
 * lattice holds EVERY value to within float rounding is the answer. A
 * continuous pen fails that test on the first values: the chance that 24
 * arbitrary floats all sit within 2 % of a level is ~1e-40.
 */
export function pressureLattice(values: ArrayLike<number>): number {
  const v = Float64Array.from(values).sort();
  let n = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] > 0 && v[i] <= 1 && (n === 0 || v[i] !== v[n - 1])) v[n++] = v[i];
  }
  if (n < LATTICE_MIN_DISTINCT) return 0;
  let gap = Infinity;
  for (let i = 1; i < n; i++) gap = Math.min(gap, v[i] - v[i - 1]);
  if (!(gap > 1 / (2 * MAX_LEVELS))) return 0;

  const fits = (N: number): boolean => {
    for (let i = 0; i < n; i++) {
      const k = v[i] * N;
      if (Math.abs(k - Math.round(k)) > LATTICE_TOLERANCE) return false;
    }
    return true;
  };
  let best = 0;
  for (let m = 1; m <= 4; m++) {
    const guess = Math.round(m / gap);
    for (let N = guess - 2; N <= guess + 2; N++) {
      if (N < 2 || N > MAX_LEVELS) continue;
      if ((best === 0 || N < best) && fits(N)) best = N;
    }
  }
  return best ? 1 / best : 0;
}

/**
 * σ of the noise on reported pressure beyond its quantization, or 0.
 *
 * The second difference p[i−1] − 2p[i] + p[i+1] of a smooth hand pressure is
 * tiny at these rates; of white noise it is √6·σ. A median (robust to the
 * hand's quick changes) estimates it; the share of quantization (Δ²/12) is
 * taken out, and the result only counts when changes also zig-zag the way
 * noise does, on a device fast enough to separate the two.
 */
export function pressureNoise(d2: ArrayLike<number>, zigzag: number, step: number, rateHz: number): number {
  if (d2.length < NOISE_MIN_SAMPLES || rateHz < NOISE_MIN_RATE || zigzag < NOISE_MIN_ZIGZAG) return 0;
  const sorted = Float64Array.from(d2).sort();
  const median = sorted[sorted.length >> 1];
  const total = (1.4826 * median) / Math.sqrt(6);
  const sensor = Math.sqrt(Math.max(0, total * total - (step * step) / 12));
  return sensor >= NOISE_MIN_SIGMA ? sensor : 0;
}

/**
 * The lowest pressure the device reports in contact, when it has a floor.
 *
 * A pen's force passes through every value from zero as it lands and lifts,
 * so a device without a floor reports small pressures at the ends of its
 * strokes. One with a floor jumps straight from nothing to its floor: every
 * stroke stays at or above one value, and touch-downs and lift-offs bunch up
 * just above it. A user who simply draws firmly never shows that bunching.
 */
export function pressureFloor(strokes: readonly StrokeStats[]): number {
  const real = strokes.filter((s) => s.samples >= 3 && !s.constant);
  if (real.length < FLOOR_MIN_STROKES) return 0;
  let floor = Infinity;
  for (const s of real) floor = Math.min(floor, s.min);
  if (!(floor >= FLOOR_MIN)) return 0;
  const near = floor * 1.5 + 0.01;
  let ends = 0;
  for (const s of real) {
    if (s.first <= near) ends++;
    if (s.last <= near) ends++;
  }
  return ends >= FLOOR_BOUNDARY_SHARE * 2 * real.length ? floor : 0;
}

/**
 * The value a device saturates at, when it does so short of 1.
 *
 * A sensor at its limit CLIPS: strokes pressed firmly run into one top value
 * and stay on it, stroke after stroke, and nothing is ever reported above it.
 * A firm, steady hand looks different — its plateau varies from stroke to
 * stroke and wavers across neighbouring values within one — so three things
 * must hold at once: no stroke goes higher; several strokes (and a share of
 * all of them) hold exactly that value for a run of samples; and in the
 * recent samples it towers over the values just below it.
 */
export function pressureCeiling(strokes: readonly StrokeStats[], values: ArrayLike<number>, step: number, floor: number): number {
  const real = strokes.filter((s) => s.samples >= 3 && !s.constant);
  if (real.length < FLOOR_MIN_STROKES) return 1;
  let max = -Infinity;
  for (const s of real) if (s.max > max) max = s.max;
  if (!(max < CEILING_MAX) || max <= floor) return 1;
  let clipped = 0;
  for (const s of real) if (s.max === max && s.atMax >= 3) clipped++;
  if (clipped < CEILING_MIN_CLIPPED || clipped < CEILING_CLIPPED_SHARE * real.length) return 1;
  const band = Math.max(2 * step, 0.004);
  let at = 0, below = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === max) at++;
    else if (v < max && v >= max - band) below++;
  }
  return at >= CEILING_SPIKE * Math.max(1, below) ? max : 1;
}

/** Median report rate in Hz from sample intervals (ms), 0 when unknown. */
export function medianRate(intervals: ArrayLike<number>): number {
  if (intervals.length < 8) return 0;
  const s = Float64Array.from(intervals).sort();
  const m = s[s.length >> 1];
  return m > 0 ? 1000 / m : 0;
}

function tierOf(p: Omit<DeviceProfile, "tier">): DeviceProfile["tier"] {
  if (p.pressure === "none") return "none";
  if (p.pressure === "unknown") return "unknown";
  const fine = p.pressureStep === 0 || p.pressureStep <= 1 / 2047;
  const clean = p.pressureNoise === 0 && p.floor === 0 && p.ceiling === 1;
  if (fine && clean && (p.rateHz === 0 || p.rateHz >= 120)) return "premium";
  if (p.pressureStep <= 1 / 511 && p.pressureNoise === 0 && (p.rateHz === 0 || p.rateHz >= 75)) return "standard";
  return "basic";
}

/* ---------- one tracker per kind of pointer, for the session ---------- */

const trackers = new Map<PointerKind, CapabilityTracker>();

/** The session's tracker for a kind of pointer. */
export function trackerFor(kind: PointerKind): CapabilityTracker {
  let t = trackers.get(kind);
  if (!t) trackers.set(kind, (t = new CapabilityTracker(kind)));
  return t;
}
