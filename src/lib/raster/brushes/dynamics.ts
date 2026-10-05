/**
 * Brush dynamics: a point on the stroke's curve → the dab a material draws.
 *
 * Every brush runs through this one evaluator; what differs is data — the
 * preset's `BrushDynamics` and its `MouseDynamics` stand-in. The device is not
 * visible here: by the time a sample reaches the stroke its pressure has been
 * read and calibrated by the input layer (lib/input), and the curve
 * (StrokePath) has smoothed it — as widely as the device needs — and
 * interpolated it along the path. So the same dynamics serve an Apple Pencil,
 * a Wacom, a cheap tablet or a mouse alike, and the materials (models/) never
 * contain a device special case.
 *
 * THE ORDER, and why it is this one:
 *
 *   1. frame     where the dab is on the stroke: time since pen-down, arc
 *                length, travel and time since the last dab, length left
 *                (known only once the pen has lifted)
 *   2. signals   hand speed on screen (canvas px/ms), tilt 0..1, lean
 *                direction — derived once, read by every later stage
 *   3. pressure  the device's, through the brush's pressure curve; or, with
 *                no pressure, the brush's stand-in, which is itself built from
 *                speed and arc length (so it needs 1 and 2)
 *   4. pressure  responses the preset adds on top of the material's own:
 *                texture, hardness
 *   5. speed     size, ink, deposit and spacing factors
 *   6. tilt      size, ink, deposit and texture factors
 *   7. rotation  user angle + barrel twist, + stroke direction or lean when
 *                the preset follows one
 *   8. taper     envelopes over arc length from both ends: after the
 *                responses, so a taper reaches its end value whatever the
 *                hand does there
 *   9. jitter    variation of the final values — after the taper, so a taper
 *                that reaches zero stays at zero
 *  10. limits    sizes and amounts non-negative, hardness within 0..1
 *
 * Stages 4–9 multiply; a preset without them leaves every value exactly as the
 * material alone would have it (no arithmetic is done for a missing response,
 * so "exactly" means bit for bit). Every response is a continuous, monotone
 * curve (curves.ts): no thresholds, no steps, at any input rate. Jitter is a
 * smooth function of arc length and the stroke's seed, so a stroke replays to
 * the same pixels and draws alike at 60 Hz and at 500 Hz.
 */

import type { StrokePoint } from "@/types/raster";
import { clamp01, mix, pressureCurve, smootherstep, smoothstep } from "./curves";
import { valueNoise1 } from "./noise";
import {
  resolveDynamics,
  resolveMouse,
  type BrushDynamics,
  type BrushInput,
  type MaterialStrokeOptions,
  type MouseDynamics,
  type Response,
} from "./types";

/** A response's factor for a signal (curves.ts); 1 when there is none. */
export function respond(r: Response | undefined, signal: number): number {
  if (!r) return 1;
  const ref = r.ref ?? 1;
  return pressureCurve(ref > 0 ? signal / ref : 0, r);
}

/** Seeds of the independent jitter channels. */
const JITTER_SIZE = 0x51e;
const JITTER_OPACITY = 0x0a7;
const JITTER_ANGLE = 0xa61;
const JITTER_SCATTER = 0x5ca;

export class DynamicsEvaluator {
  private readonly o: MaterialStrokeOptions;
  private readonly hasPressure: boolean;
  private readonly scale: number;
  private readonly mouse: MouseDynamics;
  private readonly d: BrushDynamics | undefined;
  private seed = 0;

  private startTime: number | null = null;
  private prevDistance = -1;
  private prevTime = 0;

  /** Set once the pen has lifted (see `finish`). */
  private finishing = false;
  private totalLength = Infinity;
  /** The mouse stand-in's end taper, and the preset's, fitted to the tail. */
  private mouseTaper = 0;
  private endTaper = 0;

  constructor(options: MaterialStrokeOptions, scale: number) {
    this.o = options;
    this.hasPressure = options.hasPressure;
    this.scale = scale;
    this.mouse = resolveMouse(options.brush, options.material);
    this.d = resolveDynamics(options.brush, options.material);
  }

  /** Smoothing the stroke's curve should use. */
  get smoothing(): number {
    return this.o.brush.smoothing;
  }

  /** The stroke's seed: jitter is a function of it and of arc length. */
  setSeed(seed: number): void {
    this.seed = seed;
  }

  /** Called with every raw sample: the stroke's clock starts at the first. */
  begin(time: number): void {
    if (this.startTime === null) this.startTime = time;
  }

  /**
   * The pen has lifted: the path is closed and `length` long, and dabs from
   * `drawn` (arc length of the last dab already laid) onward are the last.
   * Tapers at the end can only shape what is not drawn yet.
   */
  finish(length: number): void {
    this.totalLength = length;
    const tail = Math.max(0, length - Math.max(0, this.prevDistance));
    this.mouseTaper = Math.min(this.mouse.taper * this.o.radius, tail);
    const end = this.d?.taper?.end ?? 0;
    this.endTaper = end > 0 ? Math.min(end * this.o.radius, tail) : 0;
    this.finishing = true;
  }

  /** Evaluate one point of the curve into the dab the material will draw. */
  evaluate(pt: StrokePoint): BrushInput {
    const o = this.o;
    const d = this.d;

    // 1. frame
    const first = this.prevDistance < 0;
    const time = pt.time - (this.startTime ?? pt.time);
    const ds = first ? 0 : Math.max(0, pt.distance - this.prevDistance);
    const dt = first ? 0 : Math.max(0, time - this.prevTime);
    // A stroke that never moved is a tap. Its path length is float noise, not
    // exactly 0, so it is reported as an exact 0 for the models to test.
    const tap = this.finishing && this.totalLength < 1e-6;
    const remaining = tap
      ? 0
      : this.finishing
        ? Math.max(0, this.totalLength - pt.distance)
        : Infinity;
    this.prevDistance = pt.distance;
    this.prevTime = time;

    // 2. signals
    const velocity = pt.speed * this.scale;
    const tilt = clamp01(pt.tilt / (Math.PI / 2));

    // 3. pressure
    let pressure: number;
    if (this.hasPressure) {
      pressure = clamp01(pt.pressure);
      if (d?.pressure) pressure = pressureCurve(pressure, d.pressure);
    } else {
      pressure = this.simulatePressure(pt, velocity, remaining, tap);
    }

    let x = pt.x;
    let y = pt.y;
    let size = o.radius;
    let rotation = (o.angle ?? 0) + pt.twist;
    let opacity = 1, flow = 1, texture = 1, hardness = 0, spacing = 1;

    if (d) {
      // 4. pressure responses beyond the material's
      if (d.texture?.pressure) texture *= respond(d.texture.pressure, pressure);
      if (d.hardness) hardness = respond(d.hardness, pressure);

      // 5. speed
      if (d.size?.speed) size *= respond(d.size.speed, velocity);
      if (d.opacity?.speed) opacity *= respond(d.opacity.speed, velocity);
      if (d.flow?.speed) flow *= respond(d.flow.speed, velocity);
      if (d.spacing?.scale !== undefined) spacing *= d.spacing.scale;
      if (d.spacing?.speed) spacing *= respond(d.spacing.speed, velocity);

      // 6. tilt
      if (d.size?.tilt) size *= respond(d.size.tilt, tilt);
      if (d.opacity?.tilt) opacity *= respond(d.opacity.tilt, tilt);
      if (d.flow?.tilt) flow *= respond(d.flow.tilt, tilt);
      if (d.texture?.tilt) texture *= respond(d.texture.tilt, tilt);

      // 7. rotation
      const follow = d.rotation?.follow;
      if (follow === "direction") rotation += Math.atan2(pt.tangent.y, pt.tangent.x);
      else if (follow === "azimuth" && tilt > 0) rotation += pt.azimuth;

      // 8. taper
      // (a tap is all start and all end: it keeps its full dot)
      const t = d.taper;
      if (t && !tap) {
        const sizeTo = t.size ?? 0, opacityTo = t.opacity ?? 1;
        let k = 1;
        if (t.start && t.start > 0) k *= smootherstep(0, t.start * o.radius, pt.distance);
        if (this.endTaper > 0 && remaining < this.endTaper) k *= smootherstep(0, this.endTaper, remaining);
        if (k < 1) {
          size *= mix(sizeTo, 1, k);
          opacity *= mix(opacityTo, 1, k);
        }
      }

      // 9. jitter: smooth in arc length, about one dab apart at the brush's size
      const j = d.jitter;
      if (j) {
        const u = pt.distance / Math.max(1, 0.5 * o.radius);
        const n = (channel: number) => valueNoise1(u, (this.seed ^ channel) | 0) * 2 - 1;
        if (j.size) size *= 1 + j.size * n(JITTER_SIZE);
        if (j.opacity) opacity *= 1 + j.opacity * n(JITTER_OPACITY);
        if (j.angle) rotation += j.angle * n(JITTER_ANGLE);
        if (j.scatter) {
          const off = j.scatter * o.radius * n(JITTER_SCATTER);
          x += -pt.tangent.y * off;
          y += pt.tangent.x * off;
        }
      }

      // 10. limits
      if (size < 0) size = 0;
      if (opacity < 0) opacity = 0;
      if (flow < 0) flow = 0;
      if (texture < 0) texture = 0;
      hardness = clamp01(hardness);
      if (!(spacing > 0)) spacing = 1;
    }

    return {
      x,
      y,
      pressure,
      velocity,
      time,
      tilt,
      azimuth: pt.azimuth,
      rotation,
      tangent: pt.tangent,
      distance: pt.distance,
      ds,
      dt,
      size,
      first,
      remaining,
      opacity,
      flow,
      texture,
      hardness,
      spacing,
    };
  }

  /**
   * A mouse has no pressure, but a brush should still not be a fixed-width
   * pipe. The stand-in is what a hand does anyway: a stroke begins light and
   * settles in, lightens when it is flicked quickly, and eases off at the end.
   * Each brush chooses how much of that it wants (`MouseDynamics`) — a
   * technical pen wants none of it, an ink brush wants all of it. The result is
   * a continuous function of arc length and speed, never a step.
   */
  private simulatePressure(
    pt: StrokePoint, velocity: number, remaining: number, tap: boolean
  ): number {
    const m = this.mouse;
    let p = m.base;
    if (m.speedInfluence > 0) {
      p *= 1 - m.speedInfluence * smoothstep(0, m.speedRef, velocity);
    }
    if (tap) return p;
    if (m.ramp > 0) {
      p *= mix(m.rampFrom, 1, smootherstep(0, m.ramp * this.o.radius, pt.distance));
    }
    if (m.taper > 0 && this.mouseTaper > 0 && remaining < this.mouseTaper) {
      p *= mix(m.taperTo, 1, smootherstep(0, this.mouseTaper, remaining));
    }
    return clamp01(p);
  }
}
