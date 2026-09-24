import type { Vec2 } from "@/types/geometry";
import { EPS, PIXEL_EPS } from "@/types/geometry";
import { nearly } from "./scalar";

export const vec = (x: number, y: number): Vec2 => ({ x, y });
export const VEC_ZERO: Vec2 = { x: 0, y: 0 };
export const VEC_ONE: Vec2 = { x: 1, y: 1 };

export const vAdd = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const vSub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const vScale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const vMul = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x * b.x, y: a.y * b.y });
export const vNeg = (a: Vec2): Vec2 => ({ x: -a.x, y: -a.y });

export const vDot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
/** 2D cross product (z of the 3D cross). Sign gives orientation. */
export const vCross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;

export const vLen = (a: Vec2): number => Math.hypot(a.x, a.y);
export const vLenSq = (a: Vec2): number => a.x * a.x + a.y * a.y;
export const vDist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

export function vNormalize(a: Vec2): Vec2 {
  const l = vLen(a);
  return l <= EPS ? VEC_ZERO : { x: a.x / l, y: a.y / l };
}

/** Perpendicular, counter-clockwise in a y-down screen space. */
export const vPerp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

export const vLerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

export const vEquals = (a: Vec2, b: Vec2, tol: number = PIXEL_EPS): boolean =>
  nearly(a.x, b.x, tol) && nearly(a.y, b.y, tol);

export const vFinite = (a: Vec2): boolean =>
  Number.isFinite(a.x) && Number.isFinite(a.y);

export const vRound = (a: Vec2): Vec2 => ({
  x: Math.round(a.x),
  y: Math.round(a.y),
});
