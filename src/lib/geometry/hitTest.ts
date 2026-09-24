/**
 * Hit-testing in layer-local space.
 *
 * The rule the whole system follows: NEVER test a rotated shape in canvas
 * space. Map the pointer through the inverse layer matrix once, then test an
 * axis-aligned rect in local space. That is exact, cheap, and — crucially —
 * gives the same answer as the compositor, because both use the same matrix.
 */

import type { Mat2D, Quad, Rect, Vec2 } from "@/types/geometry";
import { PIXEL_EPS } from "@/types/geometry";
import { matApply, matApplyVector, matInvert } from "./mat2d";
import { rectContainsPoint, rectToQuad } from "./rect";
import { vCross, vDist, vLen, vSub } from "./vec2";

export type HandleId =
  | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w"
  | "rotate" | "pivot" | "body";

/** Normalized anchor of each scale handle in local [0,1]² space. */
export const HANDLE_ANCHORS: Readonly<Record<Exclude<HandleId, "rotate" | "pivot" | "body">, Vec2>> = {
  nw: { x: 0, y: 0 },
  n: { x: 0.5, y: 0 },
  ne: { x: 1, y: 0 },
  e: { x: 1, y: 0.5 },
  se: { x: 1, y: 1 },
  s: { x: 0.5, y: 1 },
  sw: { x: 0, y: 1 },
  w: { x: 0, y: 0.5 },
};

/** The handle diagonally opposite — the fixed point of a corner drag. */
export const OPPOSITE_HANDLE: Readonly<Record<string, HandleId>> = {
  nw: "se", ne: "sw", se: "nw", sw: "ne",
  n: "s", s: "n", e: "w", w: "e",
};

/** Distance, in canvas px, that the rotate handle sits outside the top edge. */
export const ROTATE_HANDLE_OFFSET = 28;

export interface HitOptions {
  /** Pointer tolerance in CANVAS px. Converted to local px per axis, so a
   *  heavily scaled-down layer still gets a finger-sized grab area. */
  readonly tolerance?: number;
  /** Optional alpha oracle in local pixel coords; when present, a hit inside
   *  the box is rejected on transparent pixels. */
  readonly alphaAt?: (x: number, y: number) => number;
  readonly alphaThreshold?: number;
}

/** Convex-polygon containment by consistent cross-product sign. Works for any
 *  winding, and the tolerance is applied along the edge normal so it behaves
 *  the same on all four sides. */
export function quadContainsPoint(q: Quad, p: Vec2, tol = 0): boolean {
  let positive = 0;
  let negative = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const edge = vSub(b, a);
    const len = vLen(edge);
    if (len <= PIXEL_EPS) continue;
    const side = vCross(edge, vSub(p, a)) / len;
    if (side > tol) positive++;
    else if (side < -tol) negative++;
  }
  return positive === 0 || negative === 0;
}

/**
 * Test a canvas-space point against a layer.
 *
 * `box` is the layer's local content rect (its crop, or its full bitmap).
 * Returns null when the matrix is singular — a zero-scale layer is invisible
 * and must therefore also be unclickable.
 */
export function hitTestLayerBox(
  matrix: Mat2D,
  box: Rect,
  pointCanvas: Vec2,
  opts: HitOptions = {}
): { local: Vec2 } | null {
  const inv = matInvert(matrix);
  if (!inv) return null;

  const local = matApply(inv, pointCanvas);
  const tol = opts.tolerance ?? 0;

  // Convert the canvas-space tolerance into local units per axis by pushing
  // the two basis directions through the inverse.
  const tx = tol > 0 ? vLen(matApplyVector(inv, { x: tol, y: 0 })) : 0;
  const ty = tol > 0 ? vLen(matApplyVector(inv, { x: 0, y: tol })) : 0;

  if (!rectContainsPoint(box, local, Math.max(tx, ty))) return null;

  if (opts.alphaAt) {
    const a = opts.alphaAt(Math.floor(local.x), Math.floor(local.y));
    if (a <= (opts.alphaThreshold ?? 0)) return null;
  }
  return { local };
}

export interface HandleHit {
  readonly id: HandleId;
  readonly position: Vec2;
}

/**
 * Pick a transform handle, in canvas space.
 *
 * Precedence is deliberate and not alphabetical: pivot, then rotate, then
 * corners, then edges, then body. The pivot marker is small and usually sits
 * under the body, so anything else first makes it unreachable; corners beat
 * edges because at small sizes their grab areas overlap and a corner drag is
 * the more specific intent.
 */
export function hitTestHandles(
  matrix: Mat2D,
  box: Rect,
  pivotLocal: Vec2,
  pointCanvas: Vec2,
  radius: number
): HandleHit | null {
  const corner = (a: Vec2): Vec2 =>
    matApply(matrix, { x: box.x + box.w * a.x, y: box.y + box.h * a.y });

  const pivot = matApply(matrix, pivotLocal);
  if (vDist(pivot, pointCanvas) <= radius) return { id: "pivot", position: pivot };

  const top = corner({ x: 0.5, y: 0 });
  const bottom = corner({ x: 0.5, y: 1 });
  const up = vSub(top, bottom);
  const upLen = vLen(up);
  const rotatePos: Vec2 = upLen > PIXEL_EPS
    ? {
        x: top.x + (up.x / upLen) * ROTATE_HANDLE_OFFSET,
        y: top.y + (up.y / upLen) * ROTATE_HANDLE_OFFSET,
      }
    : { x: top.x, y: top.y - ROTATE_HANDLE_OFFSET };

  if (vDist(rotatePos, pointCanvas) <= radius) {
    return { id: "rotate", position: rotatePos };
  }

  const order: (keyof typeof HANDLE_ANCHORS)[] = [
    "nw", "ne", "se", "sw", "n", "e", "s", "w",
  ];
  for (const id of order) {
    const pos = corner(HANDLE_ANCHORS[id]);
    if (vDist(pos, pointCanvas) <= radius) return { id, position: pos };
  }

  if (quadContainsPoint(rectTransformQuad(matrix, box), pointCanvas, 0)) {
    return { id: "body", position: pointCanvas };
  }
  return null;
}

function rectTransformQuad(m: Mat2D, r: Rect): Quad {
  const q = rectToQuad(r);
  return [matApply(m, q[0]), matApply(m, q[1]), matApply(m, q[2]), matApply(m, q[3])];
}

/* ---------------- alpha oracle ---------------- */

export interface AlphaSampler {
  readonly width: number;
  readonly height: number;
  readonly at: (x: number, y: number) => number;
}

/** Build a nearest-neighbour alpha sampler from decoded RGBA. Out-of-range
 *  reads return 0 rather than wrapping, which is what makes edge clicks
 *  behave. */
export function createAlphaSampler(
  data: Uint8ClampedArray,
  width: number,
  height: number
): AlphaSampler {
  return {
    width,
    height,
    at(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) return 0;
      return data[(y * width + x) * 4 + 3] / 255;
    },
  };
}

/** Topmost layer under the pointer. Iterates back-to-front because the
 *  compositor draws front-to-back; the two orders must be exact mirrors or
 *  clicking selects something other than what is visible. */
export function pickTopmost<T>(
  items: readonly T[],
  test: (item: T) => boolean
): T | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (test(items[i])) return items[i];
  }
  return null;
}
