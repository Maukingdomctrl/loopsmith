/**
 * Exact-area analytic coverage.
 *
 * The usual "clamp(0.5 − distance)" antialiasing is exact only for an edge
 * running along a pixel axis. At 45° it is off by ~5%, and for a stroke thinner
 * than a pixel it is simply wrong (a 0.2 px line would come out ~60% dark).
 * Both are visible as a line that wobbles in weight as it changes direction.
 *
 * The exact answer for a straight edge or strip is closed-form. Take a pixel
 * (a unit square) and an edge with unit normal n = (nx, ny). Project the square
 * onto n: the projection is a TRAPEZOID distribution (the convolution of two
 * uniform distributions of widths |nx| and |ny|). The area of the pixel on one
 * side of the edge is that trapezoid's CDF, which is piecewise quadratic —
 * `boxCdf`. A strip of half-width r whose centreline passes at distance d from
 * the pixel centre covers
 *
 *     G(r − d) + G(r + d) − 1
 *
 * of it. For wide strokes G(r + d) is 1 and this reduces to a plain edge; for
 * hairlines it gives the true, energy-preserving coverage: the total ink laid
 * down equals width × length whatever the direction.
 */

/**
 * CDF of the projection of a unit square onto a unit normal (nx, ny) given as
 * a = |nx|, b = |ny|: the fraction of the square with n·δ ≤ t, measured from the
 * square's centre.
 */
export function boxCdf(t: number, a: number, b: number): number {
  const hi = a > b ? a : b;
  const lo = a > b ? b : a;
  const u = t + (hi + lo) * 0.5;
  if (u <= 0) return 0;
  if (u >= hi + lo) return 1;
  if (lo < 1e-9) return u / hi; // axis-aligned: a plain linear ramp
  if (u <= lo) return (u * u) / (2 * hi * lo);
  if (u <= hi) return (2 * u - lo) / (2 * hi);
  const v = hi + lo - u;
  return 1 - (v * v) / (2 * hi * lo);
}

/** Coverage of a pixel by a strip of half-width r whose centreline is at
 *  perpendicular distance d, with unit normal (nx, ny). */
export function stripCoverage(d: number, r: number, nx: number, ny: number): number {
  const a = nx < 0 ? -nx : nx;
  const b = ny < 0 ? -ny : ny;
  const c = boxCdf(r - d, a, b) + boxCdf(r + d, a, b) - 1;
  return c < 0 ? 0 : c > 1 ? 1 : c;
}

/**
 * Coverage of a pixel by a disc, by ordered supersampling.
 *
 * The strip formula treats a curved boundary as a straight one, which is fine
 * once the radius is a pixel or more — and for a disc smaller than a pixel it
 * overestimates by up to 4×. Tiny dots (the cap of a hairline, a light tap)
 * are the only place that matters, and only a handful of pixels are involved,
 * so they are integrated directly. 8×8 ordered samples, deterministic.
 */
export function discCoverageSuper(
  px: number, py: number, cx: number, cy: number, r: number
): number {
  const n = 8;
  const r2 = r * r;
  let hit = 0;
  for (let j = 0; j < n; j++) {
    const sy = py + (j + 0.5) / n - cy;
    for (let i = 0; i < n; i++) {
      const sx = px + (i + 0.5) / n - cx;
      if (sx * sx + sy * sy <= r2) hit++;
    }
  }
  return hit / (n * n);
}
