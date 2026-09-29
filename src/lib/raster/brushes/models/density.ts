/**
 * Optical-density compositing, shared by every material that builds up
 * pigment (soft, texture, water).
 *
 * A material deposits DENSITY D ≥ 0 — how much pigment lies over each pixel —
 * not alpha. Light passing through pigment is absorbed exponentially, so the
 * opacity of a layer of density D is
 *
 *     α = 1 − e^(−D)
 *
 * which is the Beer–Lambert law. Two consequences are what make these brushes
 * feel like material instead of like opacity presets:
 *
 *  - Densities ADD. Laying a second pass over the first is exactly one pass
 *    of twice the density; there is no separate "stacking" rule to tune.
 *  - Opacity saturates smoothly. It approaches 1 asymptotically, so a heavy
 *    stroke gets a dense core whose edge stays soft, and an already dark
 *    area takes less and less from each further pass.
 */

import type { Rect } from "@/types/geometry";
import type { RGBA } from "@/types/raster";
import type { RasterSurface } from "../../surface";

/** Density below this is invisible (< 1/2040 opacity) and skipped. */
export const DENSITY_EPSILON = 1 / 2040;

/**
 * Composite a density field over `target` with a solid colour, inside `region`.
 * `target` already holds the pre-stroke pixels there.
 */
export function compositeDensity(
  target: RasterSurface,
  density: Float32Array,
  region: Rect,
  color: RGBA
): void {
  const w = target.width;
  const out = target.data;
  const cr = color.r, cg = color.g, cb = color.b, ca = color.a;

  for (let y = region.y; y < region.y + region.h; y++) {
    let d = y * w + region.x;
    let i = d * 4;
    for (let x = 0; x < region.w; x++, d++, i += 4) {
      const dens = density[d];
      if (dens <= DENSITY_EPSILON) continue;
      const a = (1 - Math.exp(-dens)) * ca;
      const inv = 1 - a;
      out[i]     = cr * a + out[i]     * inv;
      out[i + 1] = cg * a + out[i + 1] * inv;
      out[i + 2] = cb * a + out[i + 2] * inv;
      out[i + 3] = a + out[i + 3] * inv;
    }
  }
}
