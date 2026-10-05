/**
 * brush:check sections 12–15 and the input / dynamics rows of §11: the
 * adaptive input layer (lib/input) and the brush dynamics
 * (lib/raster/brushes/dynamics.ts), measured.
 *
 *   12  input        what each SIMULATED device class reports, and whether
 *                    the engine identifies it from that alone — and never
 *                    mistakes a good pen for a weak one
 *   13  pressure     a coarse lattice's terraces and a noisy pen's ripple are
 *                    averaged away without lag or overshoot; calibration is
 *                    monotone, exact when not needed, keeps the interior of
 *                    the range, and restores a floored / saturating device's
 *   14  dynamics     each preset response: exact when absent, monotone,
 *                    continuous, deterministic, input-rate independent
 *   15  matrix       every simulated device × gesture × report rate (60, 120,
 *                    240, 500 Hz) × a tiny and a large brush
 *
 * Every device here is a simulation (devices.ts, names "sim:…"); nothing in
 * this file is a measurement of real hardware. All values are deterministic
 * (seeded), so the QA pipeline compares them exactly against the base.
 */

import { RasterSurface } from "@/lib/raster/surface";
import { MaterialStroke } from "@/lib/raster/brushes/materialStroke";
import { BRUSHES, brushSpec } from "@/lib/raster/brushes/presets";
import { DynamicsEvaluator } from "@/lib/raster/brushes/dynamics";
import { hardTip } from "@/lib/raster/brushes/models/hard";
import type { BrushDynamics, BrushId, BrushSpec, MaterialStrokeOptions } from "@/lib/raster/brushes/types";
import type { StrokePoint, StrokeSample } from "@/types/raster";
import { pointerKind, type PointerLike, type PointerMapping } from "@/lib/input/adapter";
import { CapabilityTracker } from "@/lib/input/capabilities";
import { calibrate, IDENTITY_CALIBRATION, type PressureCalibration } from "@/lib/input/calibration";
import { pressureFilterFor, StrokeInput, strokeSample, type PressureFilter } from "@/lib/input/pipeline";
import { unknownProfile, type DeviceProfile } from "@/lib/input/types";
import { asEvents, GESTURES, SIM_DEVICES, simDevice, simulate, type Gesture, type SimDevice } from "./devices";
import { check, section } from "./report";

const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const W = 240, H = 80;
const X0 = 30, X1 = 210;

/** Client px are layer px here. */
const MAP: PointerMapping = { toLayer: (x, y) => ({ x, y }), inv: { a: 1, b: 0, c: 0, d: 1 }, viewRotation: 0 };

/* ---------------- running input through the engine ---------------- */

interface Run {
  readonly samples: StrokeSample[];
  /** Pressure as the device reported it, and as the engine passed it on. */
  readonly reported: number[];
  readonly out: number[];
  readonly times: number[];
  readonly hasPressure: boolean;
  readonly filter?: PressureFilter;
}

/** One simulated stroke through the input layer with `profile`. */
function run(d: SimDevice, g: Gesture, seed: number, profile: DeviceProfile, rate?: number, tracker: CapabilityTracker | null = null): Run {
  const events = asEvents(simulate(d, g, seed, rate));
  const input = new StrokeInput(pointerKind(d.pointerType), profile, events[0][0].pressure, tracker);
  const samples: StrokeSample[] = [];
  const out: number[] = [];
  const times: number[] = [];
  for (const batch of events) {
    input.push(batch, MAP, (s) => {
      samples.push(strokeSample(s, input.hasPressure));
      out.push(s.pressure);
      times.push(s.time);
    });
  }
  input.end();
  const reported = events.flat().map((e: PointerLike) => e.pressure);
  return { samples, reported, out, times, hasPressure: input.hasPressure, filter: input.pressureFilter };
}

/** The gestures a tracker learns a device from, in turn. */
const LEARN: Gesture[] = [
  GESTURES.medium, GESTURES.slow, GESTURES.rapid, GESTURES.swell, GESTURES.light,
  GESTURES.heavy, GESTURES.taper, GESTURES.tilted, GESTURES.fast,
];

/** A device's profile after `strokes` strokes of everyday drawing. */
function learn(d: SimDevice, strokes = 18): DeviceProfile {
  const tracker = new CapabilityTracker(pointerKind(d.pointerType));
  for (let k = 0; k < strokes; k++) run(d, LEARN[k % LEARN.length], 100 + k, tracker.profile, undefined, tracker);
  return tracker.profile;
}

const profiles = new Map<string, DeviceProfile>();
const profileOf = (d: SimDevice) => {
  let p = profiles.get(d.name);
  if (!p) profiles.set(d.name, (p = learn(d)));
  return p;
};
const rawProfile = (d: SimDevice) => unknownProfile(pointerKind(d.pointerType));

/* ---------------- rendering ---------------- */

interface Draw {
  readonly samples: readonly StrokeSample[];
  readonly hasPressure: boolean;
  readonly filter?: PressureFilter;
}

function render(r: Draw, spec: BrushSpec, size: number, seed = 7, surface?: RasterSurface): RasterSurface {
  const s = surface ?? new RasterSurface(W, H);
  const st = new MaterialStroke(s, {
    brush: spec, color: BLACK, radius: size, intensity: 1, hasPressure: r.hasPressure, scale: 1, seed,
    pressureSmoothing: r.filter?.smoothing, pressureRange: r.filter?.range,
  });
  for (const p of r.samples) st.addSample(p);
  st.end();
  return s;
}

/** The stroke the hand meant: its true pressure, continuously, at 1 kHz. */
function ideal(g: Gesture): Draw {
  const n = Math.round(g.duration) + 1;
  const samples: StrokeSample[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const p = g.path(u);
    samples.push({ x: p.x, y: p.y, pressure: Math.min(1, Math.max(0, g.pressure(u))), tilt: g.tilt?.(u) ?? 0, twist: 0, time: 1000 + u * g.duration, azimuth: 0 });
  }
  return { samples, hasPressure: true };
}

/** Ink per column across the stroke. */
function columns(s: RasterSurface): Float64Array {
  const c = new Float64Array(X1 - X0);
  for (let x = X0; x < X1; x++) {
    let v = 0;
    for (let y = 0; y < H; y++) v += s.data[(y * W + x) * 4 + 3];
    c[x - X0] = v;
  }
  return c;
}

/** Difference of two column profiles, % of the reference's total ink. */
function inkDiff(a: Float64Array, ref: Float64Array): number {
  let d = 0, t = 0;
  for (let i = 0; i < ref.length; i++) { d += Math.abs(a[i] - ref[i]); t += ref[i]; }
  return t > 0 ? (d / t) * 100 : 0;
}

/**
 * How a profile departs from the intent's at short range: RMS of the
 * difference after its own ±6-column running average is taken out, % of the
 * intent's mean. Terraces and noise show here; a uniform offset does not.
 */
function wobble(c: Float64Array, ref: Float64Array): number {
  const d = c.map((v, i) => v - ref[i]);
  let sq = 0, m = 0, n = 0;
  for (let i = 6; i < d.length - 6; i++) {
    let avg = 0;
    for (let k = -6; k <= 6; k++) avg += d[i + k];
    sq += (d[i] - avg / 13) ** 2;
    m += ref[i];
    n++;
  }
  return n && m ? (Math.sqrt(sq / n) / (m / n)) * 100 : 0;
}

const withDynamics = (id: BrushId, dynamics: BrushDynamics, extra: Partial<BrushSpec> = {}): BrushSpec =>
  ({ ...brushSpec(id), dynamics, ...extra });

const PREMIUM = ["sim:pencil-class", "sim:spen-class", "sim:wacom-winink-class"];

/* ---------------- 12. input ---------------- */

export function inputChecks(): void {
  section("12. Input: what each SIMULATED device class reports, and what the engine identifies");
  const expect: Record<string, Partial<DeviceProfile> & { noisy?: boolean }> = {
    "sim:pencil-class": { pressure: "real", pressureStep: 0, floor: 0, ceiling: 1, tilt: true, twist: false, noisy: false },
    "sim:spen-class": { pressure: "real", pressureStep: 1 / 4096, floor: 0, ceiling: 1, tilt: true, twist: false, noisy: false },
    "sim:wacom-winink-class": { pressure: "real", pressureStep: 1 / 1024, floor: 0, ceiling: 1, tilt: true, twist: true, noisy: false },
    "sim:xppen-star03-class": { pressure: "real", pressureStep: 1 / 1024, floor: 0, ceiling: 1, tilt: false, twist: false, noisy: true },
    "sim:older-tablet-class": { pressure: "real", pressureStep: 1 / 256, floor: 31 / 256, ceiling: 230 / 256, tilt: false, twist: false, noisy: true },
    "sim:touch-stylus": { pressure: "none", tilt: false },
    "sim:mouse": { pressure: "none", tilt: false },
  };
  let right = 0, rateOk = 0;
  for (const d of SIM_DEVICES) {
    const p = profileOf(d);
    const e = expect[d.name];
    const miss: string[] = [];
    for (const k of ["pressure", "pressureStep", "floor", "ceiling", "tilt", "twist"] as const) {
      if (e[k] !== undefined && p[k] !== e[k]) miss.push(`${k} ${String(p[k])} (expected ${String(e[k])})`);
    }
    if (e.noisy !== undefined && (p.pressureNoise > 0) !== e.noisy) miss.push(`noise ${p.pressureNoise.toFixed(4)}`);
    if (!miss.length) right++;
    if (Math.abs(p.rateHz - d.rate) <= 0.15 * d.rate) rateOk++;
    const levels = p.pressureStep ? `${Math.round(1 / p.pressureStep)} levels` : "continuous";
    console.log(`        ${d.name.padEnd(24)} ${p.tier.padEnd(8)} pressure ${p.pressure}, ${levels}, noise ${p.pressureNoise.toFixed(4)}, floor ${p.floor.toFixed(3)}, ceiling ${p.ceiling.toFixed(3)}, tilt ${p.tilt}, twist ${p.twist}, ${p.rateHz.toFixed(0)} Hz${miss.length ? `  ← ${miss.join("; ")}` : ""}`);
  }
  check(`devices identified exactly (of ${SIM_DEVICES.length})`, right, SIM_DEVICES.length, "", true);
  check(`report rate measured within 15 % (of ${SIM_DEVICES.length})`, rateOk, SIM_DEVICES.length, "", true);

  // a good pen must never be judged a weak one, however long it draws: a
  // false noise, floor, ceiling or coarse-lattice verdict would reshape its
  // pressure (a lattice not yet identified is the safe default, not a fault)
  let wrong = 0;
  for (const name of PREMIUM) {
    const d = simDevice(name);
    const t = new CapabilityTracker("pen");
    for (let k = 0; k < 60; k++) {
      run(d, LEARN[k % LEARN.length], 900 + k, t.profile, undefined, t);
      const p = t.profile;
      const coarser = p.pressureStep > (d.levels ? 1 / d.levels : 0) * 1.0001;
      const filter = pressureFilterFor(p);
      if (p.pressureNoise !== 0 || p.floor !== 0 || p.ceiling !== 1 || coarser || filter.range !== 0) wrong++;
    }
  }
  check("good pens judged noisy, coarse, floored, saturating (of 3 × 60)", wrong, 0);
}

/* ---------------- 13. pressure ---------------- */

export function pressureChecks(): void {
  section("13. Pressure: quantization and noise averaged without lag; calibration and range");

  // a continuous, clean pen passes through untouched, bit for bit, and draws
  // exactly what the previous input path drew from the same events
  {
    const d = simDevice("sim:pencil-class");
    const prof = profileOf(d);
    let moved = 0, pixels = 0;
    for (const [i, g] of LEARN.entries()) {
      const r = run(d, g, 300 + i, prof);
      r.out.forEach((v, k) => { if (v !== Math.min(1, Math.max(0, r.reported[k]))) moved++; });
      if (g.tilt) continue; // a tilted pen now keeps sub-degree tilt: not the previous path
      // the previous path: pressure clamped, tilt from the whole-degree
      // tiltX/tiltY, lean direction in screen space
      const legacy = asEvents(simulate(d, g, 300 + i)).flat().map((e) => {
        const tx = Math.tan(((e.tiltX || 0) * Math.PI) / 180), ty = Math.tan(((e.tiltY || 0) * Math.PI) / 180);
        return { x: e.clientX, y: e.clientY, pressure: e.pressure <= 1e-4 ? 0 : Math.min(1, e.pressure), tilt: Math.atan(Math.hypot(tx, ty)), azimuth: Math.atan2(ty, tx), twist: ((e.twist || 0) * Math.PI) / 180, time: e.timeStamp };
      });
      const a = render(r, brushSpec("hardLine"), 6).data, b = render({ samples: legacy, hasPressure: true }, brushSpec("hardLine"), 6).data;
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) pixels++;
    }
    check("continuous pen: pressures changed by the engine", moved, 0);
    check("continuous pen: pixels unlike the previous input path", pixels, 0);
  }

  // a coarse lattice: a slow swell from a whisper on a 256-level pen at an
  // older tablet's 100 Hz, large brushes — the reports as given, then with
  // the device-sized averaging its profile calls for
  {
    const coarse: SimDevice = { ...simDevice("sim:older-tablet-class"), name: "sim:256-levels", noise: 0, floor: 0, ceiling: 1 };
    const prof = learn(coarse);
    for (const [brush, size] of [["hardLine", 24], ["softRound", 30]] as const) {
      const spec = brushSpec(brush);
      const truth = columns(render(ideal(GESTURES.swell), spec, size));
      const raw = columns(render(run(coarse, GESTURES.swell, 501, rawProfile(coarse)), spec, size));
      const eng = columns(render(run(coarse, GESTURES.swell, 501, prof), spec, size));
      console.log(`        256 levels at 100 Hz, ${brush} radius ${size}: terraces ${wobble(raw, truth).toFixed(3)} % → ${wobble(eng, truth).toFixed(3)} %, ink vs intent ${inkDiff(raw, truth).toFixed(3)} % → ${inkDiff(eng, truth).toFixed(3)} %`);
      check(`256 levels, ${brush}: terraces on a slow swell`, wobble(eng, truth), 0.8 * wobble(raw, truth), " %");
    }
  }

  // noise: the XP-Pen-class pen's reports, as given and averaged as its
  // profile calls for — steady and ramping strokes, against the same pen
  // without its noise
  {
    const d = simDevice("sim:xppen-star03-class");
    const prof = profileOf(d);
    let rawW = 0, engW = 0, rawD = 0, engD = 0;
    for (const [i, g] of [GESTURES.medium, GESTURES.slow, GESTURES.swell, GESTURES.heavy].entries()) {
      const clean = columns(render(run({ ...d, noise: 0 }, g, 601 + i, rawProfile(d)), brushSpec("hardLine"), 12));
      const raw = columns(render(run(d, g, 601 + i, rawProfile(d)), brushSpec("hardLine"), 12));
      const eng = columns(render(run(d, g, 601 + i, prof), brushSpec("hardLine"), 12));
      rawW += wobble(raw, clean); engW += wobble(eng, clean);
      rawD += inkDiff(raw, clean); engD += inkDiff(eng, clean);
    }
    console.log(`        XP-Pen-class σ 0.004, hardLine radius 12, 4 strokes: width noise ${(rawW / 4).toFixed(3)} % → ${(engW / 4).toFixed(3)} %, ink vs the noise-free pen ${(rawD / 4).toFixed(3)} % → ${(engD / 4).toFixed(3)} %`);
    check("noisy pen: width noise, averaged", engW / 4, 0.75 * (rawW / 4), " %");
    check("noisy pen: ink vs the noise-free pen, averaged", engD / 4, rawD / 4, " %");
  }

  // no latency: the averaging uses only the sample the curve already waits
  // for, so after every sample exactly as much of the curve can be drawn;
  // and a sudden press never draws wider than its report
  {
    const samples: StrokeSample[] = [];
    for (let i = 0; i <= 120; i++) {
      samples.push({ x: X0 + 1.4 * i, y: 40 + 3 * Math.sin(i / 9), pressure: i < 60 ? 0.2 : 0.8, tilt: 0, twist: 0, time: 1000 + i * 10, azimuth: 0 });
    }
    const filter: PressureFilter = { smoothing: 10, range: 0.01 };
    const reach = (f?: PressureFilter) => {
      const st = new MaterialStroke(new RasterSurface(W, H), { brush: brushSpec("hardLine"), color: BLACK, radius: 8, intensity: 1, hasPressure: true, scale: 1, seed: 7, pressureSmoothing: f?.smoothing, pressureRange: f?.range });
      return samples.map((p) => { st.addSample(p); return st.strokeLength; });
    };
    const a = reach(), b = reach(filter);
    let behind = 0;
    a.forEach((v, k) => { behind = Math.max(behind, v - b[k]); });
    check("averaging: curve length held back, after any sample", behind, 0, " px");
    // (the two lines' dabs fall on different spacings, so a column may differ
    // by a sliver of anti-aliasing either way: hence a limit in % of the line)
    const firm = columns(render({ samples: samples.map((p) => ({ ...p, pressure: 0.8 })), hasPressure: true, filter }, brushSpec("hardLine"), 8));
    const stepped = columns(render({ samples, hasPressure: true, filter }, brushSpec("hardLine"), 8));
    let over = 0;
    for (let i = 0; i < stepped.length; i++) if (firm[i] > 1) over = Math.max(over, ((stepped[i] - firm[i]) / firm[i]) * 100);
    check("averaging: ink above the firmer report's, at a sudden press", over, 0.5, " %");
  }

  // calibration: exact when not needed; monotone and continuous when it is
  {
    let exact = 0;
    for (let i = 0; i <= 10000; i++) {
      const p = i / 10000 + 1e-7 * (i % 7);
      if (calibrate(p, IDENTITY_CALIBRATION) !== p) exact++;
    }
    check("identity calibration: values changed", exact, 0);
    const cals: PressureCalibration[] = [
      { floor: 0.12, ceiling: 1, response: null },
      { floor: 0, ceiling: 0.85, response: null },
      { floor: 0.08, ceiling: 0.9, response: { from: 0, to: 1, gamma: 0.6, ease: 0.3 } },
      { floor: 0.3, ceiling: 0.45, response: null },
      { floor: 0, ceiling: 1, response: { from: 0, to: 1, gamma: 1.8, ease: 0.15 } },
    ];
    let back = 0, flat = 0, jump = 0, kept = 0;
    for (const c of cals) {
      const N = 10000;
      let prev = -1;
      for (let i = 0; i <= N; i++) {
        const p = c.floor + ((c.ceiling - c.floor) * i) / N;
        const v = calibrate(p, c);
        if (prev >= 0) {
          if (v < prev) back++;
          if (v <= prev) flat++;
          jump = Math.max(jump, v - prev);
        }
        prev = v;
      }
      // the interior of a floored / saturating range is kept as reported
      if (!c.response && c.ceiling - c.floor > 0.5) {
        for (let p = c.floor + 0.25; p < c.ceiling - 0.25; p += 0.001) if (calibrate(p, c) !== p) kept++;
      }
    }
    check("calibration: steps where pressure goes down", back, 0);
    check("calibration: steps where pressure does not grow (dead zones)", flat, 0);
    check("calibration: largest change per 1/10 000 of the range", jump, 0.005);
    check("calibration: interior values moved by reshaping the ends", kept, 0);
  }

  // range: a floored, saturating tablet reaches a whisper and full pressure
  {
    const d = simDevice("sim:older-tablet-class");
    const prof = profileOf(d);
    let rawLo = 1, rawHi = 0, engLo = 1, engHi = 0;
    for (const g of [GESTURES.light, GESTURES.heavy, GESTURES.taper]) {
      const raw = run(d, g, 701, rawProfile(d)), eng = run(d, g, 701, prof);
      for (const v of raw.out) { rawLo = Math.min(rawLo, v); rawHi = Math.max(rawHi, v); }
      for (const v of eng.out) { engLo = Math.min(engLo, v); engHi = Math.max(engHi, v); }
    }
    console.log(`        older tablet (floor 0.12, saturates at 0.9): pressure range ${rawLo.toFixed(3)}–${rawHi.toFixed(3)} → ${engLo.toFixed(3)}–${engHi.toFixed(3)}`);
    check("floored tablet: lightest pressure reached, calibrated", engLo, 0.02);
    // what lies above a clip is lost; the top of the range is kept as reported
    check("saturating tablet: firmest pressure moved by calibration", Math.abs(engHi - rawHi), 0);
  }
}

/* ---------------- 14. dynamics ---------------- */

/** A dab's resolved state at a point, through the real evaluator. */
function evaluate(spec: BrushSpec, pt: Partial<StrokePoint>, opts: Partial<MaterialStrokeOptions> = {}) {
  const ev = new DynamicsEvaluator({ brush: spec, color: BLACK, radius: 10, intensity: 1, hasPressure: true, ...opts }, 1);
  ev.setSeed(5);
  ev.begin(0);
  return ev.evaluate({
    x: 50, y: 50, distance: 0, tangent: { x: 1, y: 0 }, pressure: 0.5, tilt: 0, twist: 0, speed: 0, time: 0, azimuth: 0,
    ...pt,
  } as StrokePoint);
}

/** A straight stroke at constant pressure and a given speed (px per ms). */
function straight(speed: number, pressure = 0.6, tilt = 0, rate = 240): Draw {
  const len = 180, n = Math.max(2, Math.round((len / speed / 1000) * rate) + 1);
  const samples: StrokeSample[] = [];
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    samples.push({ x: X0 - 5 + len * u, y: 40, pressure, tilt, twist: 0, time: 1000 + (u * len) / speed, azimuth: 0 });
  }
  return { samples, hasPressure: true };
}

const meanInk = (c: Float64Array, from = 20, to = c.length - 20) => {
  let s = 0;
  for (let i = from; i < to; i++) s += c[i];
  return s / (to - from);
};

/** Where a cross-section first reaches `level` of its peak, sub-pixel. */
function crossing(col: readonly number[], level: number): number {
  const peak = Math.max(...col);
  const v = level * peak;
  for (let y = 1; y < col.length; y++) {
    if (col[y] >= v) return y - 1 + (v - col[y - 1]) / (col[y] - col[y - 1] || 1);
  }
  return col.length;
}

export function dynamicsChecks(): void {
  section("14. Dynamics: each preset response — exact when absent, monotone, deterministic");

  // a preset without dynamics and one with an empty set draw the same pixels
  {
    let diff = 0;
    for (const spec of BRUSHES.filter((b) => !b.dynamics)) {
      for (const material of spec.materials?.map((m) => m.id) ?? [undefined]) {
        const { samples } = straight(1.2, 0.55);
        const a = new RasterSurface(W, H), b = new RasterSurface(W, H);
        const go = (s: RasterSurface, sp: BrushSpec) => {
          const st = new MaterialStroke(s, { brush: sp, color: BLACK, radius: 9, intensity: 0.9, material, hasPressure: true, scale: 1, seed: 3 });
          for (const p of samples) st.addSample(p);
          st.end();
        };
        go(a, spec);
        go(b, { ...spec, dynamics: {} });
        for (let k = 0; k < a.data.length; k++) if (a.data[k] !== b.data[k]) diff++;
      }
    }
    check("pixels changed by an empty set of dynamics (every brush)", diff, 0);
  }

  // the brush pressure curve composes with a material's into one monotone response
  {
    const spec = withDynamics("hardLine", { pressure: { from: 0, to: 1, gamma: 0.5, ease: 0.4 } });
    const N = 10000;
    let back = 0, flat = 0, prev = -1;
    for (let i = 0; i <= N; i++) {
      const p = evaluate(spec, { pressure: i / N }).pressure;
      const w = hardTip("pen", p, 4, 1).radius;
      if (prev >= 0) { if (w < prev) back++; if (w <= prev) flat++; }
      prev = w;
    }
    check("brush pressure curve × material: steps where width goes down", back, 0);
    check("brush pressure curve × material: steps without growth", flat, 0);
  }

  // speed: a size response makes faster strokes thinner, continuously
  {
    const spec = withDynamics("hardLine", { size: { speed: { from: 1, to: 0.45, gamma: 1, ref: 6 } } });
    let thinner = true, prev = Infinity;
    const rows: string[] = [];
    for (const v of [0.3, 1, 2, 4, 8]) {
      const ink = meanInk(columns(render(straight(v), spec, 6)));
      if (ink >= prev) thinner = false;
      prev = ink;
      rows.push(`${v} px/ms: ${ink.toFixed(2)}`);
    }
    console.log(`        ink per column by speed  ${rows.join("  ")}`);
    check("speed → size: faster always thinner (1 = yes)", thinner ? 1 : 0, 1, "", true);
    let jump = 0, last = evaluate(spec, { speed: 0 }).size;
    for (let i = 1; i <= 2000; i++) {
      const s = evaluate(spec, { speed: (i / 2000) * 10 }).size;
      jump = Math.max(jump, Math.abs(s - last));
      last = s;
    }
    check("speed → size: largest change per 0.005 px/ms", jump, 0.01, " px");
  }

  // tilt: a size response follows the lean
  {
    const spec = withDynamics("softRound", { size: { tilt: { from: 1, to: 1.8, gamma: 1 } } });
    let wider = true, prev = 0;
    for (const t of [0, 0.3, 0.6, 0.9, 1.2]) {
      const ink = meanInk(columns(render(straight(1, 0.6, t), spec, 6)));
      if (ink <= prev) wider = false;
      prev = ink;
    }
    check("tilt → size: more lean always wider (1 = yes)", wider ? 1 : 0, 1, "", true);
  }

  // rotation follows the stroke direction exactly
  {
    const spec = withDynamics("softRect", { rotation: { follow: "direction" } });
    let worst = 0;
    for (let k = 0; k < 64; k++) {
      const a = -Math.PI + (k / 64) * 2 * Math.PI;
      const r = evaluate(spec, { tangent: { x: Math.cos(a), y: Math.sin(a) }, twist: 0.25 }, { angle: 0.1 }).rotation;
      const want = 0.1 + 0.25 + Math.atan2(Math.sin(a), Math.cos(a));
      worst = Math.max(worst, Math.abs(r - want));
    }
    check("rotation following the stroke direction: largest error", worst, 1e-12, " rad");
  }

  // taper: the start of a constant-pressure line rises from nothing, smoothly
  {
    const spec = withDynamics("hardLine", { taper: { start: 4 } });
    const c = columns(render(straight(1, 0.8), spec, 6));
    const full = meanInk(c, 60, 120);
    let rises = true;
    for (let i = 1; i < 30; i++) if (c[i] + 1e-9 < c[i - 1]) rises = false;
    check("start taper: ink of the first column, % of the full line", (c[0] / full) * 100, 25, " %");
    check("start taper: rises without a dip (1 = yes)", rises ? 1 : 0, 1, "", true);
  }

  // spacing: dabs farther apart deposit the same ink per unit of travel
  {
    const a = meanInk(columns(render(straight(1), brushSpec("softRound"), 8)));
    const b = meanInk(columns(render(straight(1), withDynamics("softRound", { spacing: { scale: 2.5 } }), 8)));
    check("spacing × 2.5: change of ink per unit of travel", (Math.abs(b - a) / a) * 100, 3, " %");
  }

  // hardness: a firmer edge as hardness rises
  {
    const edge = (h: number) => {
      const c = render(straight(1, 0.7), withDynamics("softRound", { hardness: { from: h, to: h, gamma: 1 } }), 10);
      // the outer feather of the cross-section (1 % → 25 % of its peak), sub-
      // pixel; a round footprint's interior always follows its chord, however
      // hard its edge
      const col: number[] = [];
      for (let y = 0; y < H; y++) col.push(c.data[(y * W + 120) * 4 + 3]);
      return crossing(col, 0.25) - crossing(col, 0.01);
    };
    const e = [0, 0.5, 1].map(edge);
    console.log(`        soft round feather (1 → 25 %) at hardness 0, 0.5, 1: ${e.map((v) => v.toFixed(2)).join(", ")} px`);
    check("hardness: firmer edge as it rises (1 = yes)", e[0] > e[1] && e[1] > e[2] ? 1 : 0, 1, "", true);
  }

  // jitter: the same stroke replays exactly, and a 60 Hz pen draws it as a 500 Hz one does
  {
    const spec = withDynamics("softRound", { jitter: { size: 0.35, opacity: 0.3, scatter: 0.25, angle: 0.4 } });
    const a = render(straight(1), spec, 8, 11).data, b = render(straight(1), spec, 8, 11).data;
    let diff = 0;
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) diff++;
    check("jitter: pixels that differ when a stroke is replayed", diff, 0);
    const c12 = columns(render(straight(1), spec, 8, 12));
    const c11 = columns(render(straight(1), spec, 8, 11));
    let other = 0;
    for (let i = 0; i < c12.length; i++) if (c12[i] !== c11[i]) { other = 1; break; }
    check("jitter: another seed draws another stroke (1 = yes)", other, 1, "", true);
    const slow = columns(render(straight(1, 0.6, 0, 60), spec, 8, 11));
    const fast = columns(render(straight(1, 0.6, 0, 500), spec, 8, 11));
    check("jitter: 60 Hz vs 500 Hz ink difference", inkDiff(slow, fast), 5, " %");
  }

  // the eraser preset lifts more the harder it is pressed, and clears at full press
  {
    const left = (p: number) => {
      const s = new RasterSurface(W, H);
      s.fill({ r: 0.2, g: 0.3, b: 0.8, a: 1 });
      render(straight(1, p), brushSpec("eraser"), 10, 7, s);
      return s.data[(40 * W + 120) * 4 + 3];
    };
    const a = [0.2, 0.5, 1].map(left);
    console.log(`        eraser: alpha left at the centre after one pass at 20 %, 50 %, 100 %: ${a.map((v) => v.toFixed(3)).join(", ")}`);
    check("eraser: harder press lifts more (1 = yes)", a[0] > a[1] && a[1] > a[2] ? 1 : 0, 1, "", true);
    check("eraser: alpha left by one full-pressure pass", a[2], 0.1);
  }

  // the marker preset runs dry on a quick stroke
  {
    const slow = meanInk(columns(render(straight(0.5, 0.7), brushSpec("marker"), 6)));
    const fast = meanInk(columns(render(straight(7, 0.7), brushSpec("marker"), 6)));
    check("marker: a quick stroke carries less ink (1 = yes)", fast < slow ? 1 : 0, 1, "", true);
  }
}

/* ---------------- 15. cross-device matrix ---------------- */

export function matrixChecks(): void {
  section("15. Cross-device matrix (SIMULATED devices × gestures × 60/120/240/500 Hz × tiny/large brush)");
  const gestures = ["light", "medium", "heavy", "slow", "fast", "rapid", "taper", "swell"] as const;
  /** Pressure that changes faster than a 60 Hz report can follow: what a slow
   *  device cannot report is lost, not an engine fault. Reported, not judged. */
  const beyond60 = new Set(["fast", "rapid"]);
  const rates = [60, 120, 240, 500];
  const sizes = [{ brush: "hardLine" as BrushId, size: 0.6 }, { brush: "softRound" as BrushId, size: 22 }];
  let gaps = 0, worse = 0, cases = 0;
  const worseCases: string[] = [];
  let premiumRate = 0, premiumIntent = 0, lowRate = 0;
  const lost: string[] = [];
  for (const d of SIM_DEVICES) {
    const prof = profileOf(d);
    let rawErr = 0, engErr = 0, n = 0, spreadMax = 0;
    for (const gname of gestures) {
      const g = GESTURES[gname];
      for (const sz of sizes) {
        const spec = brushSpec(sz.brush);
        const truth = columns(render(ideal(g), spec, sz.size));
        const at: Float64Array[] = [];
        for (const rate of rates) {
          const seed = 1000 + rates.indexOf(rate) * 17 + gestures.indexOf(gname);
          const eng = run(d, g, seed, prof, rate);
          const c = columns(render(eng, spec, sz.size));
          // what the rate alone changes: the same device without its noise,
          // whose draws differ from one sample count to the next
          at.push(d.noise ? columns(render(run({ ...d, noise: 0 }, g, seed, prof, rate), spec, sz.size)) : c);
          cases++;
          // ink the hand meant and the device reported must not go missing;
          // where a light touch stays under a heavy activation force the
          // device reports nothing, and no software can draw that back
          const reported = d.activation > 0
            ? columns(render(run({ ...d, noise: 0 }, g, seed, rawProfile(d), rate), spec, sz.size))
            : null;
          for (let i = 0; i < c.length; i++) {
            if (c[i] <= 0 && truth[i] >= 0.05 && (!reported || reported[i] >= 0.05)) gaps++;
          }
          if (eng.hasPressure && d.pointerType === "pen") {
            const raw = run(d, g, seed, rawProfile(d), rate);
            const rc = columns(render(raw, spec, sz.size));
            const er = inkDiff(rc, truth), ee = inkDiff(c, truth);
            rawErr += er; engErr += ee; n++;
            if (ee > er + 0.5) {
              worse++;
              worseCases.push(`${d.name.slice(4)} ${gname} ${sz.brush} ${rate} Hz ${er.toFixed(2)} → ${ee.toFixed(2)} %`);
            }
          }
        }
        // what a slower report loses, against the same device at 500 Hz
        const spread = Math.max(...at.map((c) => inkDiff(c, at[at.length - 1])));
        if (beyond60.has(gname)) {
          if (sz.brush === "softRound") lost.push(`${d.name.slice(4)} ${gname} ${spread.toFixed(1)}`);
          continue;
        }
        spreadMax = Math.max(spreadMax, spread);
        if (PREMIUM.includes(d.name)) premiumRate = Math.max(premiumRate, spread);
        else if (d.pointerType === "pen") lowRate = Math.max(lowRate, spread);
        if (d.name === "sim:pencil-class") premiumIntent = Math.max(premiumIntent, ...at.map((c) => inkDiff(c, truth)));
      }
    }
    console.log(`        ${d.name.padEnd(24)} worst 60–500 Hz difference ${spreadMax.toFixed(2)} %${n ? `; vs the hand's intent, raw → engine: ${(rawErr / n).toFixed(2)} → ${(engErr / n).toFixed(2)} %` : ""}`);
  }
  console.log(`        lost to a 60 Hz report on pressure faster than it (%, large brush): ${lost.join(", ")}`);
  console.log(`        ${cases} strokes rendered${worseCases.length ? `; less faithful than raw: ${worseCases.join(", ")}` : ""}`);
  check("breaks in any stroke", gaps, 0);
  check("premium-class: worst 60 Hz vs 500 Hz ink difference", premiumRate, 2, " %");
  check("lower-end: worst 60 Hz vs 500 Hz ink difference", lowRate, 6, " %");
  check("Pencil-class: worst difference from the hand's intent", premiumIntent, 2, " %");
  check("strokes the compensation made less faithful than raw input", worse, 0);
}

/* ---------------- cost (§11 rows) ---------------- */

/** µs per sample of the input layer and of the dynamics, fastest of 3 runs. */
export function dynamicsCost(): void {
  const timeIt = (fn: () => void, n: number) => {
    let best = Infinity;
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      fn();
      best = Math.min(best, ((performance.now() - t0) / n) * 1000);
    }
    return best;
  };
  const inputCost = (d: SimDevice) => {
    const prof = learn(d, 9);
    const events = asEvents(simulate(d, { ...GESTURES.rapid, duration: 20000 }, 77, 240));
    const total = events.reduce((n, b) => n + b.length, 0);
    return timeIt(() => {
      const input = new StrokeInput("pen", prof, events[0][0].pressure, null);
      let sink = 0;
      for (const b of events) input.push(b, MAP, (s) => { sink += strokeSample(s, true).pressure; });
      if (sink < 0) console.log(sink);
    }, total);
  };
  check("input layer per sample, continuous pen (median of 3)", inputCost(simDevice("sim:pencil-class")), 50, " µs");
  check("input layer per sample, coarse floored pen (median of 3)", inputCost(simDevice("sim:older-tablet-class")), 50, " µs");

  const dynCost = (spec: BrushSpec) => {
    const n = 20000;
    const pts: StrokePoint[] = [];
    for (let i = 0; i < n; i++) {
      const a = i * 0.01;
      pts.push({ x: 100 + 50 * Math.cos(a), y: 100 + 50 * Math.sin(a), distance: i * 0.5, tangent: { x: -Math.sin(a), y: Math.cos(a) }, pressure: 0.5 + 0.4 * Math.sin(a * 3), tilt: 0.4, twist: 0, speed: 1 + Math.sin(a), time: i * 4, azimuth: 1 });
    }
    return timeIt(() => {
      const ev = new DynamicsEvaluator({ brush: spec, color: BLACK, radius: 8, intensity: 1, hasPressure: true }, 1);
      ev.setSeed(3);
      ev.begin(0);
      let sink = 0;
      for (const p of pts) sink += ev.evaluate(p).size;
      if (sink < 0) console.log(sink);
    }, n);
  };
  check("dynamics per dab, a preset without responses (median of 3)", dynCost(brushSpec("softRound")), 50, " µs");
  check("dynamics per dab, every response on (median of 3)", dynCost(withDynamics("softRect", {
    pressure: { from: 0, to: 1, gamma: 0.7 },
    size: { speed: { from: 1, to: 0.6, gamma: 1, ref: 5 }, tilt: { from: 1, to: 1.5, gamma: 1 } },
    opacity: { speed: { from: 1, to: 0.8, gamma: 1, ref: 5 }, tilt: { from: 1, to: 0.8, gamma: 1 } },
    flow: { speed: { from: 1, to: 0.9, gamma: 1, ref: 5 }, tilt: { from: 1, to: 0.9, gamma: 1 } },
    texture: { pressure: { from: 1.3, to: 0.8, gamma: 1 }, tilt: { from: 1, to: 1.4, gamma: 1 } },
    hardness: { from: 0.2, to: 0.8, gamma: 1 },
    spacing: { scale: 1.2, speed: { from: 1, to: 1.5, gamma: 1, ref: 5 } },
    rotation: { follow: "direction" },
    taper: { start: 3, end: 3, size: 0.1, opacity: 0.5 },
    jitter: { size: 0.2, opacity: 0.2, angle: 0.2, scatter: 0.2 },
  })), 50, " µs");
}
