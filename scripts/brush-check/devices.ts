/**
 * SIMULATED input devices, for the brush checks — not real hardware.
 *
 * Each profile reproduces, deterministically, what a class of device is
 * documented to deliver to a browser: report rate and its jitter, pressure
 * resolution (the lattice reported values lie on), sensor noise, a pressure
 * floor or a saturation ceiling, an activation force, which tilt channels
 * arrive and how precisely, and whether positions are sub-pixel. Every
 * number is an assumption about the class, stated here; none of this is a
 * measurement of a real pen. Validation on the actual hardware is a separate,
 * manual step (docs/brush-dynamics.md).
 *
 * A gesture is the hand's intent: a path, a "true" pressure along it, tilt.
 * `simulate` turns it into the PointerEvent-like samples the device would
 * report, grouped into the batches a browser coalesces into one frame.
 */

import type { PointerLike } from "@/lib/input/adapter";

export interface SimDevice {
  /** Always starts with "sim:" so a report can never be mistaken for hardware. */
  readonly name: string;
  readonly pointerType: "pen" | "touch" | "mouse";
  /** Reports per second, and the jitter on each report's time, ms. */
  readonly rate: number;
  readonly jitter: number;
  /** Pressure levels (reported = round(p·N)/N); 0 = a continuous float. */
  readonly levels: number;
  /** σ of sensor noise on reported pressure. */
  readonly noise: number;
  /** Lowest reported pressure in contact (0 = none). */
  readonly floor: number;
  /** Value reported pressure saturates at (1 = none). */
  readonly ceiling: number;
  /** Force (as a fraction of full) the pen needs before it reports any. */
  readonly activation: number;
  /** A constant pressure instead of any reading (a device without pressure). */
  readonly constant?: number;
  /** How tilt arrives: not at all, as whole-degree tiltX/tiltY, or as angles. */
  readonly tilt: "none" | "degrees" | "angles";
  readonly twist: boolean;
  /** Positions on a whole CSS-px grid. */
  readonly wholePixels: boolean;
  /** Timestamp resolution, ms (0 = exact). */
  readonly timeStep: number;
}

const base = {
  jitter: 0, levels: 0, noise: 0, floor: 0, ceiling: 1, activation: 0,
  tilt: "none", twist: false, wholePixels: false, timeStep: 0,
} as const;

/**
 * The device classes of the cross-device matrix. Assumptions, by class:
 *  - Apple Pencil-class: a continuous float pressure, 240 Hz, tilt and lean
 *    as angles (Safari's altitudeAngle/azimuthAngle), no barrel rotation.
 *  - S Pen-class: 4096 levels, 240 Hz, tilt as angles.
 *  - Wacom-class through Windows Ink in Chrome: Windows normalizes pressure to
 *    1024 levels; 200 Hz, a little report jitter, whole-degree tilt, twist
 *    (an Art Pen).
 *  - XP-Pen Star 03-class through Windows Ink: 1024 levels, ~133 Hz with more
 *    jitter, noisy pressure (σ 0.004), a heavy activation force (8 % of full
 *    force registers as nothing), no tilt.
 *  - Older tablet-class: 256 levels, 100 Hz, noise, a reported floor (0.12)
 *    and saturation (0.9), timestamps coarsened to 1 ms.
 *  - Touch stylus without pressure (capacitive), and a mouse.
 */
export const SIM_DEVICES: readonly SimDevice[] = [
  { ...base, name: "sim:pencil-class", pointerType: "pen", rate: 240, tilt: "angles" },
  { ...base, name: "sim:spen-class", pointerType: "pen", rate: 240, levels: 4096, tilt: "angles" },
  { ...base, name: "sim:wacom-winink-class", pointerType: "pen", rate: 200, jitter: 0.3, levels: 1024, tilt: "degrees", twist: true },
  { ...base, name: "sim:xppen-star03-class", pointerType: "pen", rate: 133, jitter: 0.8, levels: 1024, noise: 0.004, activation: 0.08 },
  { ...base, name: "sim:older-tablet-class", pointerType: "pen", rate: 100, jitter: 0.5, levels: 256, noise: 0.003, floor: 0.12, ceiling: 0.9, timeStep: 1 },
  { ...base, name: "sim:touch-stylus", pointerType: "touch", rate: 120, constant: 0.5, wholePixels: true },
  { ...base, name: "sim:mouse", pointerType: "mouse", rate: 125, constant: 0.5, wholePixels: true },
];

export const simDevice = (name: string): SimDevice => {
  const d = SIM_DEVICES.find((x) => x.name === name);
  if (!d) throw new Error(`no simulated device ${name}`);
  return d;
};

/** The hand's intent along a stroke, as functions of u ∈ [0, 1]. */
export interface Gesture {
  /** Stroke duration, ms. */
  readonly duration: number;
  readonly path: (u: number) => { x: number; y: number };
  /** True pressure 0..1 (force as a fraction of full). */
  readonly pressure: (u: number) => number;
  /** Lean from upright, radians, and its direction (screen), radians. */
  readonly tilt?: (u: number) => number;
  readonly azimuth?: (u: number) => number;
  /** Barrel rotation, degrees 0..359. */
  readonly twist?: (u: number) => number;
}

/** Deterministic PRNG (mulberry32) and a Gaussian from it. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r: () => number): number {
  const u = Math.max(1e-12, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** What the device reports for a true pressure (before float32 rounding). */
export function reportPressure(d: SimDevice, p: number, r: () => number): number {
  if (d.constant !== undefined) return d.constant;
  let q = d.activation > 0 ? Math.max(0, (p - d.activation) / (1 - d.activation)) : p;
  if (d.floor > 0) q = d.floor + (1 - d.floor) * q;
  if (d.noise > 0) q += d.noise * gauss(r);
  q = Math.min(d.ceiling, Math.max(d.floor, Math.min(1, Math.max(0, q))));
  if (d.levels > 0) q = Math.round(q * d.levels) / d.levels;
  return q;
}

export interface SimStroke {
  /** Batches of samples, each one browser event's coalesced samples. */
  readonly batches: PointerLike[][];
  /** The true pressure at each sample, in order. */
  readonly truth: number[];
}

/**
 * The samples a device reports for a gesture, `rate` Hz overriding the
 * device's own when given (the rate sweep of the matrix), coalesced into
 * 60 Hz frames as a browser would deliver them.
 */
export function simulate(d: SimDevice, g: Gesture, seed: number, rate = d.rate, t0 = 1000): SimStroke {
  const r = rng(seed);
  const n = Math.max(2, Math.round((g.duration / 1000) * rate) + 1);
  const batches: PointerLike[][] = [];
  const truth: number[] = [];
  let frame = -1;
  const deg = 180 / Math.PI;
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    let t = t0 + (i * 1000) / rate + (i > 0 && i < n - 1 ? d.jitter * (r() - 0.5) : 0);
    if (d.timeStep > 0) t = Math.floor(t / d.timeStep) * d.timeStep;
    const pos = g.path(u);
    const p = Math.min(1, Math.max(0, g.pressure(u)));
    const lean = d.tilt === "none" ? 0 : g.tilt?.(u) ?? 0;
    const az = d.tilt === "none" ? 0 : g.azimuth?.(u) ?? 0;
    const ev: {
      pointerType: string; clientX: number; clientY: number; pressure: number; timeStamp: number;
      tiltX: number; tiltY: number; twist: number; width: number; height: number;
      altitudeAngle?: number; azimuthAngle?: number;
    } = {
      pointerType: d.pointerType,
      clientX: d.wholePixels ? Math.round(pos.x) : pos.x,
      clientY: d.wholePixels ? Math.round(pos.y) : pos.y,
      pressure: Math.fround(reportPressure(d, p, r)),
      timeStamp: t,
      tiltX: 0,
      tiltY: 0,
      twist: d.twist ? Math.round(g.twist?.(u) ?? 0) % 360 : 0,
      width: d.pointerType === "touch" ? 8 : 1,
      height: d.pointerType === "touch" ? 8 : 1,
    };
    if (lean > 0) {
      // tiltX / tiltY: the plane angles of the lean, whole degrees as the spec has them
      const tx = Math.atan(Math.tan(lean) * Math.cos(az)) * deg;
      const ty = Math.atan(Math.tan(lean) * Math.sin(az)) * deg;
      ev.tiltX = Math.round(tx);
      ev.tiltY = Math.round(ty);
    }
    if (d.tilt === "angles") {
      ev.altitudeAngle = Math.PI / 2 - lean;
      ev.azimuthAngle = lean > 0 ? ((az % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) : 0;
    }
    const f = Math.floor((t - t0) / (1000 / 60));
    if (f !== frame || batches.length === 0 || i === 0) {
      batches.push([]);
      frame = f;
    }
    batches[batches.length - 1].push(ev);
    truth.push(p);
  }
  return { batches, truth };
}

/** The pointer-down event on its own, then the rest, as the canvas sees them. */
export function asEvents(s: SimStroke): PointerLike[][] {
  const first = s.batches[0];
  const out: PointerLike[][] = [[first[0]]];
  if (first.length > 1) out.push(first.slice(1));
  for (let i = 1; i < s.batches.length; i++) out.push(s.batches[i]);
  return out;
}

/* ---------------- gestures ---------------- */

const line = (x0: number, y0: number, x1: number, y1: number) => (u: number) => ({
  x: x0 + (x1 - x0) * u,
  y: y0 + (y1 - y0) * u,
});

/** A pen landing and lifting: the force rises from 0 and falls back to it,
 *  over `ms` at each end (a landing takes a hand about 15 ms). */
const landed = (p: (u: number) => number, duration: number, ms = 15) => (u: number) => {
  const edge = Math.min(0.45, ms / duration);
  const a = Math.min(1, u / edge), b = Math.min(1, (1 - u) / edge);
  const s = (t: number) => t * t * (3 - 2 * t);
  return p(u) * s(a) * s(b);
};

/**
 * A hand's force is never exactly constant: physiological tremor (~9.5 Hz)
 * and a slow drift move it by a few tenths of a percent. Real pens report
 * that; a simulation without it would show a steady pressure as a run of
 * identical values no real stroke produces.
 */
const tremor = (p: (u: number) => number, duration: number) => (u: number) => {
  const t = (u * duration) / 1000;
  return p(u) * (1 + 0.004 * Math.sin(2 * Math.PI * 9.5 * t) + 0.003 * Math.sin(2 * Math.PI * 1.3 * t + 1));
};

const gesture = (duration: number, pressure: (u: number) => number, extra: Partial<Gesture> = {}): Gesture => ({
  duration, path: line(20, 40, 220, 40), pressure: tremor(pressure, duration), ...extra,
});

export const GESTURES = {
  light: gesture(900, landed(() => 0.15, 900)),
  medium: gesture(900, landed(() => 0.5, 900)),
  heavy: gesture(900, landed(() => 0.95, 900)),
  slow: gesture(2400, landed((u) => 0.3 + 0.4 * u, 2400)),
  /** 3.3 px/ms: at 60 Hz the device reports only a few samples on the way */
  fast: gesture(60, landed((u) => 0.3 + 0.4 * u, 60)),
  /** 9 swells a second: faster than a 60 Hz report rate can follow */
  rapid: gesture(1200, landed((u) => 0.5 + 0.35 * Math.sin(u * Math.PI * 2 * 9), 1200)),
  /** a slow swell from a whisper to firm: where pressure resolution shows */
  swell: gesture(3000, (u) => 0.02 + 0.6 * u * u),
  taper: gesture(900, (u) => 0.9 * Math.min(1, (1 - u) * 2.5) * Math.min(1, u * 8)),
  tilted: gesture(1200, landed(() => 0.6, 1200), {
    tilt: (u: number) => 0.35 + 0.5 * u, azimuth: (u: number) => Math.PI * (0.9 + 0.25 * u),
    twist: (u: number) => 350 + 30 * u,
  }),
} satisfies Record<string, Gesture>;
