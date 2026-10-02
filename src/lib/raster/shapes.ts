/**
 * Shape rasterization by signed distance field.
 *
 * WHY SDFs. Every shape reduces to one scalar function f(x,y) = signed
 * distance to its boundary, and then fill, stroke and antialiasing are three
 * trivial readings of that one function:
 *
 *     fill coverage   = clamp(0.5 − f/aa, 0, 1)
 *     stroke coverage = clamp(0.5 − (|f| − w/2)/aa, 0, 1)
 *
 * The consequences are worth the up-front maths. Stroke and fill are exactly
 * coincident, so no seam ever appears between them. Antialiasing is analytic
 * and correct at every angle, including the sharp vertices of a triangle or an
 * arrowhead, where a scanline polygon filler needs explicit supersampling.
 * And rotation is free: rotate the sample point, evaluate the axis-aligned
 * field — no vertex transformation, no winding rules, no self-intersection
 * special cases.
 */

import type { Rect, Vec2 } from "@/types/geometry";
import type { ShapeGeometry, ShapeStyle } from "@/types/raster";
import { CoverageBuffer, RasterSurface } from "./surface";
import { rectCenter, rectNormalize } from "@/lib/geometry/rect";
import { clamp } from "@/lib/geometry/scalar";
import {
  DEFAULT_ARROW_HEAD_LENGTH,
  DEFAULT_ARROW_HEAD_WIDTH,
  EDGE_AA_WIDTH,
  MIN_SHAPE_SIZE,
  STAMP_PADDING,
} from "./constants";

/** Inner-to-outer radius of the star: 0.5 reads as a friendly emoji star. */
const STAR_INNER_RATIO = 0.5;

/* ============================================================ */
/*  primitive SDFs — all in shape-local, centre-origin space    */
/* ============================================================ */

/** Rounded box. Negative inside. Exact for r = 0 and for r > 0 alike. */
function sdRoundBox(px: number, py: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(px) - hx + r;
  const qy = Math.abs(py) - hy + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * Ellipse distance.
 *
 * There is no closed form for the exact Euclidean distance to an ellipse
 * (it requires a quartic root). This is the standard gradient-normalized
 * approximation: the implicit value scaled by the inverse gradient magnitude.
 * Its error is second-order in eccentricity and stays well under half a pixel
 * for the aspect ratios a drawing tool produces — invisible in a one-pixel AA
 * band, and it costs three multiplies instead of a quartic solve.
 */
function sdEllipse(px: number, py: number, hx: number, hy: number): number {
  const ax = Math.max(hx, 1e-6), ay = Math.max(hy, 1e-6);
  const nx = px / ax, ny = py / ay;
  const implicit = nx * nx + ny * ny - 1;
  const gx = (2 * px) / (ax * ax), gy = (2 * py) / (ay * ay);
  const grad = Math.hypot(gx, gy);
  return grad > 1e-9 ? implicit / grad : implicit;
}

/** Distance to a capsule (thick segment). Exact. */
function sdSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const pax = px - ax, pay = py - ay;
  const bax = bx - ax, bay = by - ay;
  const denom = bax * bax + bay * bay;
  // Degenerate segment is a point; that is the correct limit, not an error.
  const h = denom > 1e-12 ? clamp((pax * bax + pay * bay) / denom, 0, 1) : 0;
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/**
 * Five-pointed star of outer radius r, pointing up (canvas y grows down).
 * `inner` is the inner-to-outer radius ratio. Exact for the regular star;
 * the caller squashes the sample point for non-square rects, which bends the
 * distance slightly — well inside the one-pixel antialiasing band.
 */
function sdStar5(px: number, py: number, r: number, inner: number): number {
  const k1x = 0.809016994375, k1y = -0.587785252292;
  const k2x = -k1x, k2y = k1y;
  let x = Math.abs(px);
  let y = -py; // point up on a y-down canvas
  let d = 2 * Math.max(k1x * x + k1y * y, 0);
  x -= d * k1x; y -= d * k1y;
  d = 2 * Math.max(k2x * x + k2y * y, 0);
  x -= d * k2x; y -= d * k2y;
  x = Math.abs(x);
  y -= r;
  const bax = inner * -k1y, bay = inner * k1x - 1;
  const h = clamp((x * bax + y * bay) / (bax * bax + bay * bay), 0, r);
  const ex = x - bax * h, ey = y - bay * h;
  return Math.hypot(ex, ey) * Math.sign(y * bax - x * bay);
}

/**
 * Distance to a triangle. Exact, including the sign.
 *
 * The sign comes from the consistency of the three edge cross products, which
 * is winding-independent — so the caller never has to order the vertices.
 */
function sdTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): number {
  const d = Math.min(
    sdSegment(p.x, p.y, a.x, a.y, b.x, b.y),
    sdSegment(p.x, p.y, b.x, b.y, c.x, c.y),
    sdSegment(p.x, p.y, c.x, c.y, a.x, a.y)
  );
  const s1 = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  const s2 = (c.x - b.x) * (p.y - b.y) - (c.y - b.y) * (p.x - b.x);
  const s3 = (a.x - c.x) * (p.y - c.y) - (a.y - c.y) * (p.x - c.x);
  const inside = (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  return inside ? -d : d;
}

/** Union of two fields — min for SDFs. Used to weld an arrow's shaft to its head. */
const sdUnion = (a: number, b: number): number => Math.min(a, b);

/* ============================================================ */
/*  shape field                                                 */
/* ============================================================ */

type Field = (x: number, y: number) => number;

/**
 * Build the signed distance field for a shape, in LOCAL surface coordinates.
 *
 * Rotation is applied to the sample point, not to the geometry — that is what
 * makes every shape rotatable with no per-shape code and with exact AA at any
 * angle.
 */
function buildField(geom: ShapeGeometry): { field: Field; bounds: Rect } {
  const r = rectNormalize(geom.rect);
  const c = rectCenter(r);
  const rad = (geom.rotation * Math.PI) / 180;
  const cos = Math.cos(-rad), sin = Math.sin(-rad);

  const toLocal = (x: number, y: number): Vec2 => {
    const dx = x - c.x, dy = y - c.y;
    return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
  };

  const hx = Math.max(MIN_SHAPE_SIZE, r.w / 2);
  const hy = Math.max(MIN_SHAPE_SIZE, r.h / 2);

  switch (geom.kind) {
    case "rectangle": {
      // Clamp the corner radius to half the short side; a larger value is
      // geometrically meaningless and makes sdRoundBox inflate the shape.
      const cr = clamp(geom.cornerRadiusOverride ?? 0, 0, Math.min(hx, hy));
      return {
        field: (x, y) => { const p = toLocal(x, y); return sdRoundBox(p.x, p.y, hx, hy, cr); },
        bounds: r,
      };
    }
    case "ellipse":
      return {
        field: (x, y) => { const p = toLocal(x, y); return sdEllipse(p.x, p.y, hx, hy); },
        bounds: r,
      };
    case "line": {
      const a = geom.from ?? { x: r.x, y: r.y };
      const b = geom.to ?? { x: r.x + r.w, y: r.y + r.h };
      // Lines are unrotated: their endpoints already encode direction, and
      // applying `rotation` as well would double-transform them.
      return {
        field: (x, y) => sdSegment(x, y, a.x, a.y, b.x, b.y),
        bounds: rectNormalize({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }),
      };
    }
    case "triangle": {
      const apex = clamp(geom.apex ?? 0.5, 0, 1);
      const a: Vec2 = { x: -hx + 2 * hx * apex, y: -hy };
      const b: Vec2 = { x: hx, y: hy };
      const d: Vec2 = { x: -hx, y: hy };
      return {
        field: (x, y) => sdTriangle(toLocal(x, y), a, b, d),
        bounds: r,
      };
    }
    case "arrow": {
      const a = geom.from ?? { x: r.x, y: r.y };
      const b = geom.to ?? { x: r.x + r.w, y: r.y + r.h };
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) {
        return { field: (x, y) => sdSegment(x, y, a.x, a.y, b.x, b.y), bounds: r };
      }
      const ux = dx / len, uy = dy / len;
      const hl = Math.min(geom.headLength ?? DEFAULT_ARROW_HEAD_LENGTH, len * 0.9);
      const hw = geom.headWidth ?? DEFAULT_ARROW_HEAD_WIDTH;

      // Shaft stops at the head's base so the two do not overlap and inflate
      // the stroke where they meet.
      const baseX = b.x - ux * hl, baseY = b.y - uy * hl;
      const px = -uy, py = ux;
      const tip: Vec2 = b;
      const left: Vec2 = { x: baseX + px * hw, y: baseY + py * hw };
      const right: Vec2 = { x: baseX - px * hw, y: baseY - py * hw };

      const pad = hw + hl;
      return {
        field: (x, y) => sdUnion(
          sdSegment(x, y, a.x, a.y, baseX, baseY),
          sdTriangle({ x, y }, tip, left, right)
        ),
        bounds: rectNormalize({
          x: Math.min(a.x, b.x) - pad, y: Math.min(a.y, b.y) - pad,
          w: Math.abs(dx) + 2 * pad, h: Math.abs(dy) + 2 * pad,
        }),
      };
    }
    case "star": {
      // Fit the star to the rect: sample in a square space of radius
      // min(hx, hy), stretched back out to the rect's aspect.
      const rr = Math.min(hx, hy);
      const sx = rr / hx, sy = rr / hy;
      return {
        field: (x, y) => {
          const p = toLocal(x, y);
          return sdStar5(p.x * sx, p.y * sy, rr, STAR_INNER_RATIO) / Math.max(sx, sy);
        },
        bounds: r,
      };
    }
  }
}

/* ============================================================ */
/*  rasterization                                               */
/* ============================================================ */

/** Geometry plus the style's corner radius, so buildField stays style-free. */
type GeomWithRadius = ShapeGeometry & { cornerRadiusOverride?: number };

function rasterizeField(
  coverage: CoverageBuffer,
  field: Field,
  bounds: Rect,
  pad: number,
  convert: (d: number) => number
): Rect {
  const x0 = Math.max(0, Math.floor(bounds.x - pad));
  const y0 = Math.max(0, Math.floor(bounds.y - pad));
  const x1 = Math.min(coverage.width, Math.ceil(bounds.x + bounds.w + pad) + 1);
  const y1 = Math.min(coverage.height, Math.ceil(bounds.y + bounds.h + pad) + 1);
  if (x1 <= x0 || y1 <= y0) return { x: 0, y: 0, w: 0, h: 0 };

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      // Pixel CENTRE. Sampling the corner shifts every shape by half a pixel,
      // which is the classic off-by-half that makes a 1 px line straddle two.
      const cov = convert(field(x + 0.5, y + 0.5));
      if (cov > 0) coverage.addMax(x, y, cov);
    }
  }
  coverage.dirty.add(x0, y0, x1, y1);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export interface ShapeDrawResult {
  readonly fillBounds: Rect | null;
  readonly strokeBounds: Rect | null;
}

/**
 * Draw a shape into a surface.
 *
 * Fill and stroke use SEPARATE coverage buffers, composited fill-first. They
 * cannot share one buffer: a semi-transparent stroke over a fill must show the
 * fill through it, and `max` accumulation into a single mask would flatten the
 * two into one silhouette and lose that.
 */
export function drawShape(
  surface: RasterSurface,
  geom: ShapeGeometry,
  style: ShapeStyle
): ShapeDrawResult {
  const withRadius: GeomWithRadius = { ...geom, cornerRadiusOverride: style.cornerRadius };
  const { field, bounds } = buildField(withRadius as ShapeGeometry);

  const aa = Math.max(1e-6, style.antialias > 0 ? style.antialias : EDGE_AA_WIDTH);
  const hardEdge = style.antialias <= 0;
  const result: { fillBounds: Rect | null; strokeBounds: Rect | null } =
    { fillBounds: null, strokeBounds: null };

  // Lines and arrows have no interior to fill; filling them would just draw
  // the stroke twice at the wrong width.
  const fillable = geom.kind !== "line" && geom.kind !== "arrow";

  if (style.fill && fillable) {
    const cov = surface.createCoverage();
    result.fillBounds = rasterizeField(cov, field, bounds, STAMP_PADDING, (d) =>
      hardEdge ? (d <= 0 ? 1 : 0) : clamp(0.5 - d / aa, 0, 1)
    );
    surface.compositeCoverage(cov, style.fill, style.opacity, style.blend, cov.integerBounds());
  }

  if (style.stroke && style.strokeWidth > 0) {
    const hw = style.strokeWidth / 2;
    const cov = surface.createCoverage();
    result.strokeBounds = rasterizeField(cov, field, bounds, hw + STAMP_PADDING, (d) => {
      // |d| − hw is the distance to the stroke's own boundary: the stroke is
      // centred on the outline, which is what makes it align with the fill.
      const sd = Math.abs(d) - hw;
      return hardEdge ? (sd <= 0 ? 1 : 0) : clamp(0.5 - sd / aa, 0, 1);
    });
    surface.compositeCoverage(cov, style.stroke, style.opacity, style.blend, cov.integerBounds());
  }
  return result;
}

/** Coverage only — for previews, and for erasing in a shape. */
export function shapeCoverage(
  surface: RasterSurface,
  geom: ShapeGeometry,
  style: ShapeStyle
): CoverageBuffer {
  const withRadius: GeomWithRadius = { ...geom, cornerRadiusOverride: style.cornerRadius };
  const { field, bounds } = buildField(withRadius as ShapeGeometry);
  const aa = Math.max(1e-6, style.antialias > 0 ? style.antialias : EDGE_AA_WIDTH);
  const cov = surface.createCoverage();

  if (style.fill && geom.kind !== "line" && geom.kind !== "arrow") {
    rasterizeField(cov, field, bounds, STAMP_PADDING, (d) => clamp(0.5 - d / aa, 0, 1));
  }
  if (style.stroke && style.strokeWidth > 0) {
    const hw = style.strokeWidth / 2;
    rasterizeField(cov, field, bounds, hw + STAMP_PADDING, (d) =>
      clamp(0.5 - (Math.abs(d) - hw) / aa, 0, 1)
    );
  }
  return cov;
}

/**
 * Build geometry from a two-point drag — the universal shape gesture.
 *
 * `constrain` is the shift modifier: squares, circles, and 45°-snapped lines.
 * `fromCenter` is alt: the drag origin becomes the centre.
 */
export function geometryFromDrag(
  kind: ShapeGeometry["kind"],
  start: Vec2,
  end: Vec2,
  opts: { constrain?: boolean; fromCenter?: boolean; rotation?: number } = {}
): ShapeGeometry {
  let a = start, b = end;

  if (opts.constrain) {
    if (kind === "line" || kind === "arrow") {
      // Snap the direction to the nearest 45°, preserving the drag length.
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const snapped = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      b = { x: a.x + Math.cos(snapped) * len, y: a.y + Math.sin(snapped) * len };
    } else {
      const s = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      b = { x: a.x + Math.sign(b.x - a.x || 1) * s, y: a.y + Math.sign(b.y - a.y || 1) * s };
    }
  }

  if (opts.fromCenter) {
    const dx = b.x - a.x, dy = b.y - a.y;
    a = { x: start.x - dx, y: start.y - dy };
  }

  const r = rectNormalize({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });
  return {
    kind,
    rect: r,
    rotation: opts.rotation ?? 0,
    from: a,
    to: b,
    headLength: DEFAULT_ARROW_HEAD_LENGTH,
    headWidth: DEFAULT_ARROW_HEAD_WIDTH,
    apex: 0.5,
  };
}
