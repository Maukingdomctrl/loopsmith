import type { Mat2D, Quad, Rect, Vec2 } from "@/types/geometry";
import { PIXEL_EPS } from "@/types/geometry";
import { matApply } from "./mat2d";
import { clamp, nearly } from "./scalar";

export const RECT_EMPTY: Rect = { x: 0, y: 0, w: 0, h: 0 };

export const rect = (x: number, y: number, w: number, h: number): Rect =>
  ({ x, y, w, h });

/** Absorb negative width/height produced by dragging a handle past its
 *  opposite edge. Every rect that leaves a UI interaction goes through this. */
export function rectNormalize(r: Rect): Rect {
  const x = r.w < 0 ? r.x + r.w : r.x;
  const y = r.h < 0 ? r.y + r.h : r.y;
  return { x, y, w: Math.abs(r.w), h: Math.abs(r.h) };
}

export const rectFromPoints = (a: Vec2, b: Vec2): Rect =>
  rectNormalize({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y });

export const rectRight = (r: Rect): number => r.x + r.w;
export const rectBottom = (r: Rect): number => r.y + r.h;
export const rectArea = (r: Rect): number => Math.max(0, r.w) * Math.max(0, r.h);
export const rectIsEmpty = (r: Rect): boolean =>
  !(r.w > PIXEL_EPS && r.h > PIXEL_EPS);

export const rectCenter = (r: Rect): Vec2 =>
  ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export const rectEquals = (a: Rect, b: Rect, tol = PIXEL_EPS): boolean =>
  nearly(a.x, b.x, tol) &&
  nearly(a.y, b.y, tol) &&
  nearly(a.w, b.w, tol) &&
  nearly(a.h, b.h, tol);

/** Corners in TL, TR, BR, BL order — the order every quad consumer assumes. */
export function rectToQuad(r: Rect): Quad {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

export function quadTransform(m: Mat2D, q: Quad): Quad {
  return [matApply(m, q[0]), matApply(m, q[1]), matApply(m, q[2]), matApply(m, q[3])];
}

/** The oriented image of a rect. Rotation-exact; nothing is lost yet. */
export const rectTransformToQuad = (m: Mat2D, r: Rect): Quad =>
  quadTransform(m, rectToQuad(r));

export function quadBounds(q: Quad): Rect {
  let minX = q[0].x, maxX = q[0].x, minY = q[0].y, maxY = q[0].y;
  for (let i = 1; i < 4; i++) {
    const p = q[i];
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Axis-aligned bounds of a transformed rect.
 *
 * Deliberately the AABB of the four transformed corners, NOT the transform of
 * the AABB — the latter is wrong for any rotation and grows without bound
 * under repeated application.
 */
export const rectTransformBounds = (m: Mat2D, r: Rect): Rect =>
  quadBounds(rectTransformToQuad(m, r));

export function rectUnion(a: Rect, b: Rect): Rect {
  if (rectIsEmpty(a)) return b;
  if (rectIsEmpty(b)) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(rectRight(a), rectRight(b)) - x,
    h: Math.max(rectBottom(a), rectBottom(b)) - y,
  };
}

export function rectUnionAll(rs: readonly Rect[]): Rect {
  return rs.reduce<Rect>((acc, r) => rectUnion(acc, r), RECT_EMPTY);
}

export function rectIntersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(rectRight(a), rectRight(b)) - x;
  const h = Math.min(rectBottom(a), rectBottom(b)) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : RECT_EMPTY;
}

export const rectContainsPoint = (r: Rect, p: Vec2, tol = 0): boolean =>
  p.x >= r.x - tol &&
  p.y >= r.y - tol &&
  p.x <= rectRight(r) + tol &&
  p.y <= rectBottom(r) + tol;

export const rectContainsRect = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x - PIXEL_EPS &&
  inner.y >= outer.y - PIXEL_EPS &&
  rectRight(inner) <= rectRight(outer) + PIXEL_EPS &&
  rectBottom(inner) <= rectBottom(outer) + PIXEL_EPS;

export const rectInflate = (r: Rect, dx: number, dy: number = dx): Rect =>
  rectNormalize({ x: r.x - dx, y: r.y - dy, w: r.w + 2 * dx, h: r.h + 2 * dy });

export function rectClampTo(r: Rect, bounds: Rect): Rect {
  const n = rectNormalize(r);
  const w = Math.min(n.w, bounds.w);
  const h = Math.min(n.h, bounds.h);
  return {
    x: clamp(n.x, bounds.x, rectRight(bounds) - w),
    y: clamp(n.y, bounds.y, rectBottom(bounds) - h),
    w,
    h,
  };
}

/** Integer rect that fully covers `r`. Used when a rect becomes a bitmap. */
export const rectOuterPixels = (r: Rect): Rect => {
  const n = rectNormalize(r);
  const x = Math.floor(n.x);
  const y = Math.floor(n.y);
  return {
    x,
    y,
    w: Math.max(1, Math.ceil(rectRight(n)) - x),
    h: Math.max(1, Math.ceil(rectBottom(n)) - y),
  };
};

/* ---------------- fitting ---------------- */

/** "Contain" scale of a w×h source into a rect. Shared with frameTransform's
 *  fitScale, which now delegates here so the two cannot drift. */
export function containScale(
  sourceW: number,
  sourceH: number,
  targetW: number,
  targetH: number
): number {
  const w = Math.max(1, sourceW);
  const h = Math.max(1, sourceH);
  return Math.min(targetW / w, targetH / h);
}

export const coverScale = (
  sourceW: number,
  sourceH: number,
  targetW: number,
  targetH: number
): number =>
  Math.max(targetW / Math.max(1, sourceW), targetH / Math.max(1, sourceH));

/** Aspect-preserving resize of `r` about a fixed anchor in [0,1]² space. */
export function rectScaleAbout(
  r: Rect,
  sx: number,
  sy: number,
  anchor: Vec2
): Rect {
  const ax = r.x + r.w * anchor.x;
  const ay = r.y + r.h * anchor.y;
  return rectNormalize({
    x: ax + (r.x - ax) * sx,
    y: ay + (r.y - ay) * sy,
    w: r.w * sx,
    h: r.h * sy,
  });
}
