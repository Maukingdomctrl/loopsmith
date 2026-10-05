/**
 * Brush engine check — `npm run brush:check`.
 *
 * Measures the properties a professional inking brush must have instead of
 * judging them by eye, and fails (exit 1) when one regresses:
 *
 *   coverage     every pixel against the EXACT area the ideal stroke covers
 *                (truth.ts), on lines at many angles, widths and sub-pixel
 *                offsets, on curves, at stroke ends and on taps
 *   light touch  1 % … 100 % pressure, slow lines: no gaps, no beads, visible
 *   sub-pixel    a line moved by 1/8 px moves its ink by 1/8 px
 *   pressure     the pressure → width curve is continuous, monotone, step-free
 *   transitions  the same gesture reported at 60 Hz and at 500 Hz draws alike
 *   path         a fast stroke stays on the drawn curve
 *   hardness     anti-aliasing never reaches beyond the pixel the edge crosses
 *   all brushes  the shared stroke pipeline keeps every material continuous
 *   cost         time per pointer sample: stroke and model, input layer,
 *                dynamics
 *   input        §12–15 (dynamics.ts): the adaptive input layer and the brush
 *                dynamics, on SIMULATED device classes (devices.ts) — device
 *                identification, premium pens untouched, quantization and
 *                noise averaged without lag, calibration, every preset
 *                response, and a cross-device × report-rate matrix
 *
 * Runs the app's own TypeScript under Node (no browser, no build).
 * `--sheet <file.png>` sets where the visual test sheet is written.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { RasterSurface } from "@/lib/raster/surface";
import { MaterialStroke } from "@/lib/raster/brushes/materialStroke";
import { brushSpec } from "@/lib/raster/brushes/presets";
import { HardModel, hardTip } from "@/lib/raster/brushes/models/hard";
import type { BrushId, BrushInput, ModelContext } from "@/lib/raster/brushes/types";
import { truthCoverage, type Disc } from "./truth";
import { writePng } from "./png";
import { check, failureCount, section } from "./report";
import { dynamicsChecks, dynamicsCost, inputChecks, matrixChecks, pressureChecks } from "./dynamics";

const BLACK = { r: 0, g: 0, b: 0, a: 1 };
const LV = 255; // one 8-bit level

/* ---------------- drawing ---------------- */

interface Pt { x: number; y: number }

interface StrokeOpts {
  W: number;
  H: number;
  brush?: BrushId;
  size: number;
  scale?: number;
  pressure: number | ((t: number) => number);
  pts: readonly Pt[];
  /** ms between samples */
  dt?: number;
  surface?: RasterSurface;
}

/** One stroke through the real pipeline (pressure filter → curve → model). */
function stroke(o: StrokeOpts): RasterSurface {
  const surface = o.surface ?? new RasterSurface(o.W, o.H);
  const s = new MaterialStroke(surface, {
    brush: brushSpec(o.brush ?? "hardLine"),
    color: BLACK,
    radius: o.size,
    intensity: 1,
    hasPressure: true,
    scale: o.scale ?? 1,
  });
  const n = o.pts.length;
  o.pts.forEach((p, i) => {
    const t = n > 1 ? i / (n - 1) : 0;
    const pressure = typeof o.pressure === "function" ? o.pressure(t) : o.pressure;
    s.addSample({ x: p.x, y: p.y, pressure, tilt: 0, twist: 0, time: i * (o.dt ?? 4) });
  });
  s.end();
  return surface;
}

/** Points from a to b, `step` px apart, ends included. */
function line(ax: number, ay: number, bx: number, by: number, step: number): Pt[] {
  const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
  return Array.from({ length: n + 1 }, (_, i) => ({ x: ax + ((bx - ax) * i) / n, y: ay + ((by - ay) * i) / n }));
}

const alpha = (s: RasterSurface): Float64Array =>
  Float64Array.from({ length: s.width * s.height }, (_, i) => s.data[i * 4 + 3]);

/** Alpha as committed: quantized to 8 bits. */
const alpha8 = (s: RasterSurface): Float64Array => {
  const d = s.toImageData().data;
  return Float64Array.from({ length: s.width * s.height }, (_, i) => d[i * 4 + 3] / 255);
};

/** Ink per column (the stroke's cross-section mass) for x in [x0, x1). */
function columns(a: Float64Array, W: number, H: number, x0: number, x1: number): number[] {
  const out: number[] = [];
  for (let x = x0; x < x1; x++) {
    let s = 0;
    for (let y = 0; y < H; y++) s += a[y * W + x];
    out.push(s);
  }
  return out;
}

const mean = (v: number[]) => v.reduce((p, q) => p + q, 0) / v.length;
const ripple = (v: number[]) => {
  const m = mean(v);
  return Math.sqrt(v.reduce((p, q) => p + (q - m) ** 2, 0) / v.length) / (m || 1);
};

/* ---------------- 1. coverage ---------------- */

function coverageLines(): void {
  section("1. Coverage of straight lines vs the exact area (8 angles × 9 widths × 4 sub-pixel offsets)");
  let body = 0, cap = 0, mass = 0;
  for (const d of [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 6, 12]) {
    for (const deg of [0, 7, 22.5, 30, 45, 60, 83, 90]) {
      for (const off of [0, 0.125, 0.375, 0.625]) {
        const W = 64, H = 64;
        const a = (deg * Math.PI) / 180;
        const cx = 32 + off, cy = 32 + off * 0.7;
        const dx = Math.cos(a) * 12, dy = Math.sin(a) * 12;
        const tip = hardTip("pen", 1, d / 2, 1);
        const m = alpha(stroke({ W, H, size: d / 2, pressure: 1, pts: line(cx - dx, cy - dy, cx + dx, cy + dy, 0.5) }));
        const ends: Disc[] = [{ x: cx - dx, y: cy - dy, r: tip.radius }, { x: cx + dx, y: cy + dy, r: tip.radius }];
        const g = truthCoverage(ends, W, H);
        let sm = 0, sg = 0;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const i = y * W + x;
          const e = Math.abs(m[i] - g[i] * tip.opacity);
          sm += m[i]; sg += g[i] * tip.opacity;
          const nearEnd = ends.some((p) => Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y) < p.r + 1.5);
          if (nearEnd) cap = Math.max(cap, e); else body = Math.max(body, e);
        }
        mass = Math.max(mass, Math.abs(sm / sg - 1));
      }
    }
  }
  check("worst pixel along the line (no staircase, no beads)", body * LV, 1.5, " lv");
  check("worst pixel at the round ends", cap * LV, 3, " lv");
  check("total ink vs exact area", mass * 100, 0.5, " %");
}

/** The hard model alone, fed exact points, against the exact union of its cones. */
function coverageCurves(): void {
  section("2. Coverage of curves (arcs of radius 2.5–20 px, lines 0.5–6 px wide)");
  let worst = 0, rms = 0, contact = 0;
  for (const R of [2.5, 6, 20]) {
    for (const d of [0.5, 1.5, 6]) {
      // 70 % of a circle measures the curve; 85 % also brings the round ends
      // of the stroke into contact with each other
      for (const arc of [0.7, 0.85]) {
      const W = 2 * Math.ceil(R + d + 4), H = W;
      const cx = W / 2 + 0.31, cy = H / 2 + 0.17;
      const size = d / 2;
      const ctx: ModelContext = {
        width: W, height: H, baseline: new Float32Array(W * H * 4), color: BLACK,
        intensity: 1, material: "pen", seed: 1, size, scale: 1, angle: 0, shape: "round", aspect: 1,
      };
      const model = new HardModel(ctx);
      const n = Math.ceil((2 * Math.PI * R) / 0.7);
      const discs: Disc[] = [];
      const tip = hardTip("pen", 1, size, 1);
      for (let i = 0; i <= Math.floor(n * arc); i++) {
        const a = (i / n) * 2 * Math.PI;
        const x = cx + R * Math.cos(a), y = cy + R * Math.sin(a);
        discs.push({ x, y, r: tip.radius });
        const input: BrushInput = {
          x, y, pressure: 1, velocity: 0, time: i, tilt: 0, azimuth: 0, rotation: 0,
          tangent: { x: -Math.sin(a), y: Math.cos(a) }, distance: (i * 2 * Math.PI * R) / n,
          ds: 0, dt: 0, size, first: i === 0, remaining: Infinity,
          opacity: 1, flow: 1, texture: 1, hardness: 0, spacing: 1,
        };
        model.dab(input);
      }
      model.settle();
      const s = new RasterSurface(W, H);
      model.composite(s, { x: 0, y: 0, w: W, h: H });
      const m = alpha(s);
      const g = truthCoverage(discs, W, H);
      let sq = 0, cnt = 0, w = 0;
      for (let i = 0; i < g.length; i++) {
        const e = Math.abs(m[i] - g[i]);
        w = Math.max(w, e);
        if (g[i] > 0 || m[i] > 0) { sq += e * e; cnt++; }
      }
      if (arc < 0.8) {
        worst = Math.max(worst, w);
        rms = Math.max(rms, Math.sqrt(sq / cnt));
      } else {
        contact = Math.max(contact, w);
      }
      }
    }
  }
  check("worst pixel on a curve", worst * LV, 4, " lv");
  check("rms error on the tightest curve", rms * LV, 2, " lv");
  // Where two separate parts of one stroke graze inside the same 1/16-pixel
  // cell, the union inside that cell is a max — the engine's resolution limit.
  check("worst pixel where the stroke's two ends touch", contact * LV, 12, " lv");
}

/* ---------------- 3. light touch ---------------- */

function lightTouch(scale: number): void {
  section(`3. Light touch: slow 30° lines, 1 % … 100 % pressure, layer zoom ${scale}×`);
  let prev = 0, rising = true, worstRipple = 0, gaps = 0, faintest = Infinity;
  const rows: string[] = [];
  for (const p of [0.01, 0.02, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1]) {
    const W = 220, H = 140, a = Math.PI / 6;
    const s = stroke({
      W, H, size: 2 / scale, scale, pressure: p,
      pts: line(15, 15, 15 + Math.cos(a) * 200, 15 + Math.sin(a) * 200, 0.25 / scale),
    });
    const a8 = alpha8(s);
    const col = columns(a8, W, H, 30, 170);
    let peak = 0;
    for (const v of a8) peak = Math.max(peak, v);
    gaps += col.filter((v) => v <= 0).length;
    worstRipple = Math.max(worstRipple, ripple(col));
    if (mean(col) <= prev) rising = false;
    prev = mean(col);
    faintest = Math.min(faintest, peak * LV);
    const tip = hardTip("pen", p, 2 / scale, scale);
    rows.push(`${(p * 100).toFixed(0)}%: ${(tip.radius * 2).toFixed(2)} px × ${tip.opacity.toFixed(2)}`);
  }
  console.log(`        width × opacity  ${rows.join("  ")}`);
  check("columns with no ink (breaks)", gaps, 0);
  check("cross-section ripple after 8-bit commit (beads, dots)", worstRipple * 100, 2, " %");
  check("darkest pixel of the 1 % line (it must not vanish)", faintest, 24, " lv", true);
  check("more pressure always more ink (1 = yes)", rising ? 1 : 0, 1, "", true);
}

/* ---------------- 4. sub-pixel ---------------- */

function subpixel(): void {
  section("4. Sub-pixel position: lines moved in 1/8 px steps, ink centroid vs the exact one");
  let worstC = 0, worstM = 0;
  for (const [deg, size, p] of [[0, 0.5, 1], [0, 0.125, 1], [30, 0.5, 1], [0, 2, 0.05], [45, 1.5, 1]]) {
    const a = (deg * Math.PI) / 180;
    const nx = -Math.sin(a), ny = Math.cos(a);
    for (let k = 0; k <= 8; k++) {
      const W = 80, H = 80;
      const cx = 40 + (nx * k) / 8, cy = 40 + (ny * k) / 8;
      const dx = Math.cos(a) * 25, dy = Math.sin(a) * 25;
      const tip = hardTip("pen", p, size, 1);
      const m = alpha(stroke({ W, H, size, pressure: p, pts: line(cx - dx, cy - dy, cx + dx, cy + dy, 0.5) }));
      const g = truthCoverage([{ x: cx - dx, y: cy - dy, r: tip.radius }, { x: cx + dx, y: cy + dy, r: tip.radius }], W, H);
      let s = 0, w = 0, gs = 0, gw = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const qx = x + 0.5 - 40, qy = y + 0.5 - 40;
        if (Math.abs(qx * Math.cos(a) + qy * Math.sin(a)) > 15) continue;
        const across = qx * nx + qy * ny;
        const v = m[y * W + x], gv = g[y * W + x] * tip.opacity;
        s += v * across; w += v; gs += gv * across; gw += gv;
      }
      worstC = Math.max(worstC, Math.abs(s / w - gs / gw));
      worstM = Math.max(worstM, Math.abs(w / gw - 1));
    }
  }
  check("centroid error", worstC, 0.01, " px");
  check("ink error at any offset", worstM * 100, 0.5, " %");
}

/* ---------------- 5. pressure curve ---------------- */

function pressureCurve(): void {
  section("5. Pressure → width and opacity, 10 000 steps from 0 to 1 (pen, pencil, ink)");
  let back = 0, flat = 0, jump = 0, slope = 0;
  for (const material of ["pen", "pencil", "ink"]) {
    const N = 10000;
    const d0 = hardTip(material, 0, 4, 1).radius * 2, d1 = hardTip(material, 1, 4, 1).radius * 2;
    const avg = (d1 - d0) / N;
    let pd = -1, po = -1, ps = -1;
    for (let i = 0; i <= N; i++) {
      const t = hardTip(material, i / N, 4, 1);
      const d = t.radius * 2;
      if (pd >= 0) {
        const step = d - pd;
        if (step < 0 || t.opacity < po) back++;
        if (step <= 0) flat++;
        jump = Math.max(jump, step / avg);
        if (ps >= 0) slope = Math.max(slope, Math.abs(step - ps) / avg);
        ps = step;
      }
      pd = d; po = t.opacity;
    }
  }
  check("steps where width or opacity goes down", back, 0);
  check("steps where width does not grow (dead zones, quantization)", flat, 0);
  check("largest width step, × the average step", jump, 2);
  check("largest change of slope, × the average step (kinks)", slope, 0.1);
}

/* ---------------- 6. transitions and fast strokes ---------------- */

/** Cross-section profile of a pressure ramp drawn with the given sample spacing. */
function rampProfile(brush: BrushId, step: number, dt: number, size: number): number[] {
  const W = 240, H = 60;
  const ramp = (x: number) => 0.02 + 0.4 * ((x - 20) / 200) ** 2;
  const pts = line(20, 30, 220, 30, step);
  const s = new RasterSurface(W, H);
  const st = new MaterialStroke(s, { brush: brushSpec(brush), color: BLACK, radius: size, intensity: 1, hasPressure: true, scale: 1 });
  pts.forEach((p, i) => st.addSample({ x: p.x, y: p.y, pressure: ramp(p.x), tilt: 0, twist: 0, time: i * dt }));
  st.end();
  return columns(alpha(s), W, H, 0, W);
}

/** The same gesture (1.56 px/ms) reported by a 500 Hz and a 60 Hz device. */
const FAST_REPORTS = [3.125, 2] as const;
const SLOW_REPORTS = [25, 16] as const;

function transitions(): void {
  section("6. Pressure 2 % → 42 % along a line, one gesture reported at 500 Hz and at 60 Hz");
  const dense = rampProfile("hardLine", ...FAST_REPORTS, 6);
  const sparse = rampProfile("hardLine", ...SLOW_REPORTS, 6);
  let diff = 0, peak = 0, gaps = 0;
  for (let x = 30; x < 210; x++) {
    diff = Math.max(diff, Math.abs(dense[x] - sparse[x]));
    peak = Math.max(peak, dense[x]);
    if (sparse[x] <= 0) gaps++;
  }
  check("difference between the two, % of the line's peak", (diff / peak) * 100, 1, " %");
  check("breaks in the 60 Hz stroke", gaps, 0);
}

function pathFidelity(): void {
  section("7. Path: an S-curve drawn slowly (0.3 px samples) and fast (18 px samples)");
  const W = 240, H = 120;
  const fy = (x: number) => 60 + 30 * Math.sin((2 * Math.PI * (x - 20)) / 200);
  for (const [label, step, limit] of [["slow", 0.3, 0.1], ["fast", 18, 0.35]] as const) {
    const pts: Pt[] = [];
    for (let x = 20; x <= 220 + 1e-9; x += step) pts.push({ x, y: fy(x) });
    const a = alpha(stroke({ W, H, size: 1.5, pressure: 0.6, pts, dt: step > 5 ? 16 : 2 }));
    let dev = 0;
    for (let x = 40; x < 200; x++) {
      let s = 0, w = 0;
      for (let y = 0; y < H; y++) { const v = a[y * W + x]; s += v * (y + 0.5); w += v; }
      if (w > 0) dev = Math.max(dev, Math.abs(s / w - fy(x + 0.5)));
    }
    check(`${label}: centreline distance from the drawn curve`, dev, limit, " px");
  }
}

/* ---------------- 8. hard edge ---------------- */

function hardEdge(): void {
  section("8. Hard edge: partial pixels only where the exact edge passes through them");
  let worst = 0;
  for (const deg of [0, 17, 45, 71]) {
    const W = 80, H = 80, a = (deg * Math.PI) / 180;
    const ax = 40 - Math.cos(a) * 20 + 0.3, ay = 40 - Math.sin(a) * 20 + 0.6;
    const bx = 40 + Math.cos(a) * 20 + 0.3, by = 40 + Math.sin(a) * 20 + 0.6;
    const tip = hardTip("pen", 1, 6, 1);
    const m = alpha(stroke({ W, H, size: 6, pressure: 1, pts: line(ax, ay, bx, by, 0.5) }));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = m[y * W + x];
      if (v <= 0.002 || v >= 0.998) continue;
      // distance from the pixel centre to the capsule's outline
      const qx = x + 0.5, qy = y + 0.5;
      const abx = bx - ax, aby = by - ay;
      const t = Math.max(0, Math.min(1, ((qx - ax) * abx + (qy - ay) * aby) / (abx * abx + aby * aby)));
      const sd = Math.hypot(qx - ax - t * abx, qy - ay - t * aby) - tip.radius;
      worst = Math.max(worst, Math.abs(sd));
    }
  }
  check("farthest partial pixel from the edge (≤ half a pixel diagonal)", worst, 0.708, " px");
}

/* ---------------- 9. ends and taps ---------------- */

function endsAndTaps(): void {
  section("9. Stroke ends and taps at 2 %, 5 %, 30 % and 100 % pressure");
  let line_ = 0, tap = 0;
  for (const p of [0.02, 0.05, 0.3, 1]) {
    const W = 48, H = 48;
    const tip = hardTip("pen", p, 2, 1);
    const a: Disc = { x: 14.3, y: 20.6, r: tip.radius }, b: Disc = { x: 31.1, y: 26.2, r: tip.radius };
    const m = alpha(stroke({ W, H, size: 2, pressure: p, pts: line(a.x, a.y, b.x, b.y, 0.4) }));
    const g = truthCoverage([a, b], W, H);
    for (let i = 0; i < m.length; i++) line_ = Math.max(line_, Math.abs(m[i] - g[i] * tip.opacity));
    const c: Disc = { x: 24.37, y: 24.81, r: tip.radius };
    const mt = alpha(stroke({ W, H, size: 2, pressure: p, pts: [c] }));
    const gt = truthCoverage([c], W, H);
    for (let i = 0; i < mt.length; i++) tap = Math.max(tap, Math.abs(mt[i] - gt[i] * tip.opacity));
  }
  check("worst pixel of a short line, ends included", line_ * LV, 3, " lv");
  check("worst pixel of a tap", tap * LV, 3, " lv");
}

/* ---------------- 10. every brush ---------------- */

function allBrushes(): void {
  section("10. Every brush through the shared pipeline: slow and fast strokes, pressure ramps");
  for (const brush of ["softRound", "softRect", "water", "texture"] as BrushId[]) {
    const dense = rampProfile(brush, ...FAST_REPORTS, 6);
    const sparse = rampProfile(brush, ...SLOW_REPORTS, 6);
    let gapsD = 0, gapsS = 0, diff = 0, peak = 0;
    for (let x = 30; x < 210; x++) {
      if (dense[x] <= 0) gapsD++;
      if (sparse[x] <= 0) gapsS++;
      diff += Math.abs(dense[x] - sparse[x]);
      peak += dense[x];
    }
    check(`${brush}: breaks in slow + fast strokes`, gapsD + gapsS, 0);
    check(`${brush}: 60 Hz vs 500 Hz ink difference`, (diff / peak) * 100, 5, " %");
  }
}

/* ---------------- 11. cost ---------------- */

function cost(): void {
  section("11. Cost per pointer sample (curve + model + incremental preview), 240 Hz pen");
  const run = (size: number, step: number) => {
    const s = new RasterSurface(512, 512);
    const st = new MaterialStroke(s, { brush: brushSpec("hardLine"), color: BLACK, radius: size, intensity: 1, hasPressure: true, scale: 1 });
    const n = Math.round(1200 / step);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const d = i * step;
      st.addSample({
        x: 60 + 190 * (1 + Math.sin(d / 97)) + 0.37, y: 60 + 190 * (1 + Math.sin(d / 61)) + 0.11,
        pressure: 0.3 + 0.6 * Math.abs(Math.sin(d / 150)), tilt: 0, twist: 0, time: i * 4.17,
      });
      st.previewInto(s);
    }
    st.end();
    return ((performance.now() - t0) / n) * 1000;
  };
  run(2, 3); // warm up
  for (const [size, step] of [[2, 3], [2, 10], [12, 3], [12, 10], [24, 10]]) {
    const times = [run(size, step), run(size, step), run(size, step)].sort((p, q) => p - q);
    check(`size ${size}, ${step} px per sample (median of 3)`, times[1], 2000, " µs");
  }
  dynamicsCost();
}

/* ---------------- sheet ---------------- */

function sheet(path: string): void {
  const W = 760, H = 520;
  const s = new RasterSurface(W, H);
  const add = (o: Omit<StrokeOpts, "W" | "H">) => stroke({ ...o, W, H, surface: s });
  // light-touch ladder: 1 % … 100 %, slow
  [0.01, 0.02, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1].forEach((p, i) =>
    add({ size: 2, pressure: p, pts: line(20 + i * 22, 20, 60 + i * 22, 150, 0.25) }));
  // line widths 0.25 … 3 px
  [0.25, 0.5, 0.75, 1, 1.5, 2, 3].forEach((d, i) =>
    add({ size: d / 2, pressure: 1, pts: line(240 + i * 22, 20, 280 + i * 22, 150, 0.3) }));
  // a fan of directions
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * (Math.PI / 2);
    add({ size: 0.75, pressure: 1, pts: line(420, 150, 420 + Math.cos(a) * 130, 150 - Math.sin(a) * 130, 0.4) });
  }
  // pressure ramps
  add({ size: 4, pressure: (t) => t, pts: line(20, 200, 740, 200, 0.3) });
  add({ size: 4, pressure: (t) => 1 - t, pts: line(20, 230, 740, 230, 0.3) });
  add({ size: 1, pressure: (t) => Math.sin(Math.PI * t), pts: line(20, 255, 740, 262, 0.3) });
  // circles at 3 %, 15 %, 50 %, 100 %
  [0.03, 0.15, 0.5, 1].forEach((p, k) => {
    const pts: Pt[] = [];
    for (let i = 0; i <= 600; i++) {
      const a = (i / 600) * Math.PI * 2;
      pts.push({ x: 90 + k * 170 + 60 * Math.cos(a), y: 380 + 60 * Math.sin(a) });
    }
    add({ size: 1.5, pressure: p, pts });
  });
  // a fast stroke: samples 20 px apart
  const fast: Pt[] = [];
  for (let x = 20; x <= 740; x += 20) fast.push({ x, y: 480 + 20 * Math.sin(x / 40) });
  add({ size: 1.5, pressure: (t) => 0.1 + 0.8 * Math.sin(Math.PI * t), pts: fast, dt: 16 });
  writePng(path, s, W, H);
  console.log(`\nVisual sheet: ${path}`);
}

/* ---------------- run ---------------- */

const sheetArg = process.argv.indexOf("--sheet");
const sheetPath = sheetArg > 0 ? process.argv[sheetArg + 1] : join(tmpdir(), "brush-check.png");

console.log("Brush engine check (Hard Linework unless named)");
coverageLines();
coverageCurves();
lightTouch(1);
lightTouch(4);
subpixel();
pressureCurve();
transitions();
pathFidelity();
hardEdge();
endsAndTaps();
allBrushes();
cost();
inputChecks();
pressureChecks();
dynamicsChecks();
matrixChecks();
sheet(sheetPath);

const failures = failureCount();
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exitCode = failures ? 1 : 0;
