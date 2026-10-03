/**
 * Ground truth for the brush checks: the EXACT fraction of every pixel covered
 * by a union of round cones (a stroke's geometry), independent of the engine.
 *
 * Each cone is convex, so it cuts a horizontal line in one interval; the
 * intervals of all cones are merged per line and measured against each pixel
 * exactly. Lines are integrated per pixel row by the midpoint rule, with the
 * row split at every cone's top and bottom so a horizontal edge is never
 * straddled by a quadrature cell (that alone would cost 1/lines of accuracy).
 */

import { sdRoundCone } from "@/lib/raster/brushes/analytic";

export interface Disc {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

const sd = (x: number, y: number, a: Disc, b: Disc) =>
  sdRoundCone(x, y, a.x, a.y, a.r, b.x, b.y, b.r);

/** The x-interval where cone (a, b) meets the horizontal line y, or null. */
function coneSpan(a: Disc, b: Disc, y: number): [number, number] | null {
  const L = Math.min(a.x - a.r, b.x - b.r) - 1;
  const R = Math.max(a.x + a.r, b.x + b.r) + 1;
  // the distance is convex along the line: golden-section to its minimum…
  const g = 0.6180339887498949;
  let lo = L, hi = R;
  let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo);
  let f1 = sd(x1, y, a, b), f2 = sd(x2, y, a, b);
  for (let i = 0; i < 80; i++) {
    if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = sd(x1, y, a, b); }
    else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = sd(x2, y, a, b); }
  }
  const xm = (lo + hi) / 2;
  if (sd(xm, y, a, b) > 0) return null;
  // …then bisection for where it crosses zero on either side
  let l = L, r = xm;
  for (let i = 0; i < 60; i++) { const m = (l + r) / 2; if (sd(m, y, a, b) > 0) l = m; else r = m; }
  const left = r;
  l = xm; r = R;
  for (let i = 0; i < 60; i++) { const m = (l + r) / 2; if (sd(m, y, a, b) > 0) r = m; else l = m; }
  return [left, l];
}

/** Coverage in [0, 1] of every pixel of a W×H grid by the union of the cones
 *  between consecutive discs (one disc alone is a dot). */
export function truthCoverage(discs: readonly Disc[], W: number, H: number, lines = 96): Float64Array {
  const cov = new Float64Array(W * H);
  const cones: [Disc, Disc][] = [];
  if (discs.length === 1) cones.push([discs[0], discs[0]]);
  for (let i = 1; i < discs.length; i++) cones.push([discs[i - 1], discs[i]]);
  const top = cones.map(([a, b]) => Math.min(a.y - a.r, b.y - b.r));
  const bottom = cones.map(([a, b]) => Math.max(a.y + a.r, b.y + b.r));
  const y0 = Math.max(0, Math.floor(Math.min(...top)));
  const y1 = Math.min(H, Math.ceil(Math.max(...bottom)));

  const scan = (py: number, y: number, weight: number) => {
    const spans: [number, number][] = [];
    for (let c = 0; c < cones.length; c++) {
      if (y < top[c] || y > bottom[c]) continue;
      const s = coneSpan(cones[c][0], cones[c][1], y);
      if (s) spans.push(s);
    }
    spans.sort((p, q) => p[0] - q[0]);
    let cur: [number, number] | null = null;
    const flush = () => {
      if (!cur) return;
      const [x0, x1] = cur;
      for (let px = Math.max(0, Math.floor(x0)); px <= Math.min(W - 1, Math.floor(x1)); px++) {
        const ov = Math.min(px + 1, x1) - Math.max(px, x0);
        if (ov > 0) cov[py * W + px] += ov * weight;
      }
    };
    for (const s of spans) {
      if (cur && s[0] <= cur[1]) cur[1] = Math.max(cur[1], s[1]);
      else { flush(); cur = [s[0], s[1]]; }
    }
    flush();
  };

  for (let py = y0; py < y1; py++) {
    const cuts = [py, py + 1];
    for (let c = 0; c < cones.length; c++) {
      if (top[c] > py && top[c] < py + 1) cuts.push(top[c]);
      if (bottom[c] > py && bottom[c] < py + 1) cuts.push(bottom[c]);
    }
    cuts.sort((p, q) => p - q);
    for (let k = 1; k < cuts.length; k++) {
      const h = cuts[k] - cuts[k - 1];
      if (h <= 1e-12) continue;
      const n = Math.max(8, Math.ceil(lines * h));
      for (let s = 0; s < n; s++) scan(py, cuts[k - 1] + ((s + 0.5) / n) * h, h / n);
    }
  }
  return cov;
}
