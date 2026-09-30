/**
 * Squash & stretch, as in classic animation: the layer gets taller and
 * thinner (stretch) or shorter and wider (squash) while its area stays the
 * same, around an anchor that stays put (the feet, by default).
 *
 * Stateless: the amount is read back from the pose itself, so there is no
 * extra data to keep in sync, and the Transform panel, handles and undo all
 * keep working on the same numbers.
 */

import type { Rect, Vec2 } from "@/types/geometry";
import type { Layer } from "@/types/layer";
import type { Pose } from "@/lib/geometry/pose";
import { makePose } from "@/lib/geometry/pose";
import { matApply } from "@/lib/geometry/mat2d";
import { rectIntersect, rectIsEmpty, rectUnionAll } from "@/lib/geometry/rect";
import { PENCIL_STRIDE, P_X, P_Y } from "@/lib/pencil/types";
import { layerContentBox, layerMatrix } from "./layerSpace";
import { getCachedBitmap } from "./flatten";

export type SquashAnchor = "bottom" | "center" | "top";

/**
 * Which of the layer's own axes is nearer the canvas vertical, and which way
 * along it is down (+1 / −1). A pose has no shear, so squashing straight down
 * is only exact along the layer's own axes: the nearer one is used, so a
 * drawing turned past 45° (lying down, upside down, flipped) still squashes
 * toward the ground and lands on the edge that faces it.
 */
function verticalAxis(pose: Pose): { axis: "x" | "y"; down: 1 | -1 } {
  const r = (pose.rotation * Math.PI) / 180;
  const x = Math.sign(pose.scale.x || 1) * Math.sin(r); // how much local +x points down
  const y = Math.sign(pose.scale.y || 1) * Math.cos(r); // how much local +y points down
  return Math.abs(y) >= Math.abs(x)
    ? { axis: "y", down: y >= 0 ? 1 : -1 }
    : { axis: "x", down: x >= 0 ? 1 : -1 };
}

/** Height ÷ width factor (along the axis nearest vertical), relative to the
 *  layer's own proportions: 1 = as drawn, >1 stretched, <1 squashed. */
export function stretchOf(pose: Pose): number {
  const sx = Math.abs(pose.scale.x), sy = Math.abs(pose.scale.y);
  if (!(sx > 0 && sy > 0)) return 1;
  return verticalAxis(pose).axis === "y" ? Math.sqrt(sy / sx) : Math.sqrt(sx / sy);
}

/** Slider value (−100..100, % taller or wider) ⇄ stretch factor. */
export const stretchToAmount = (k: number) => Math.round((k >= 1 ? k - 1 : 1 - 1 / k) * 100);
export const amountToStretch = (v: number) => (v >= 0 ? 1 + v / 100 : 1 / (1 - v / 100));

/** Pixels fainter than this (of 255) are haze, not drawing: AI art often has
 *  a faint veil that would otherwise put the "feet" in empty space. */
const ALPHA_MIN = 16;

/** Bounds of the pixels actually drawn (alpha ≥ ALPHA_MIN) in an image, by image. */
const drawnCache = new Map<string, Rect | null>();

function drawnBounds(src: string): Rect | null {
  if (drawnCache.has(src)) return drawnCache.get(src)!;
  const img = getCachedBitmap(src);
  if (!img || typeof document === "undefined") return null; // not decoded yet
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] < ALPHA_MIN) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  const r = x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  drawnCache.set(src, r);
  if (drawnCache.size > 256) drawnCache.delete(drawnCache.keys().next().value as string);
  return r;
}

/** Layer-space bounds of a layer's pencil lines (tip radius included; erase
 *  strokes left out, since they add nothing). */
function strokeBounds(layer: Layer): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of layer.strokes ?? []) {
    if (s.kind !== "graphite") continue;
    for (let o = 0; o + P_Y < s.pts.length; o += PENCIL_STRIDE) {
      const x = s.pts[o + P_X], y = s.pts[o + P_Y];
      x0 = Math.min(x0, x - s.size);
      y0 = Math.min(y0, y - s.size);
      x1 = Math.max(x1, x + s.size);
      y1 = Math.max(y1, y + s.size);
    }
  }
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * The layer-space point that stays put: the bottom, centre or top of what is
 * actually drawn — pixels and pencil lines, inside the layer's crop — so
 * "bottom" means the character's feet, not the empty margin of its cell.
 * Falls back to the layer's box.
 */
export function squashAnchorPoint(layer: Layer, anchor: SquashAnchor): Vec2 {
  const box = layerContentBox(layer);
  const parts = [layer.image ? drawnBounds(layer.image) : null, strokeBounds(layer)];
  const drawn = rectIntersect(rectUnionAll(parts.filter((r): r is Rect => !!r)), box);
  const r = rectIsEmpty(drawn) ? box : drawn;
  const mid = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  if (anchor === "center") return mid;
  // The edge that faces the ground ("bottom") or the sky ("top") on the canvas.
  const { axis, down } = verticalAxis(layer.pose);
  const far = (anchor === "bottom" ? down : -down) > 0;
  return axis === "y"
    ? { x: mid.x, y: far ? r.y + r.h : r.y }
    : { x: far ? r.x + r.w : r.x, y: mid.y };
}

/** The layer's pose squashed or stretched to factor `k`, area preserved,
 *  flips kept, the layer-space point `local` fixed on the canvas. */
export function squashPose(layer: Layer, k: number, local: Vec2): Pose {
  const { pose } = layer;
  const sx = pose.scale.x, sy = pose.scale.y;
  const area = Math.sqrt(Math.abs(sx * sy));
  const kk = Math.max(0.2, Math.min(5, k));
  // Taller along the layer's axis nearest vertical, narrower across it.
  const [fx, fy] = verticalAxis(pose).axis === "y" ? [1 / kk, kk] : [kk, 1 / kk];
  const next = makePose({
    ...pose,
    scale: { x: Math.sign(sx || 1) * area * fx, y: Math.sign(sy || 1) * area * fy },
  });

  const before = matApply(layerMatrix(layer), local);
  const after = matApply(layerMatrix({ ...layer, pose: next }), local);
  return makePose({
    ...next,
    position: {
      x: next.position.x + before.x - after.x,
      y: next.position.y + before.y - after.y,
    },
  });
}

/* ---------------- bounce ---------------- */

/**
 * One bounce cycle as squash/stretch, for phase t in [0, 1), where 0 is the
 * landing frame: squashed on the ground (−1); in the air, stretched in
 * proportion to speed, so the frames just before and after the landing are
 * the most stretched and the top of the jump (no speed) is as drawn.
 *
 * Speed is the slope of `hopAt` (4 − 8t), normalised: |1 − 2t|.
 */
export function bounceAt(t: number): number {
  const p = ((t % 1) + 1) % 1;
  if (p < 1e-9 || p > 1 - 1e-9) return -1;
  return Math.abs(1 - 2 * p);
}

/**
 * Bounce phase of every frame, in [0, 1): the middle of its time on screen,
 * counted in ticks from the middle of the landing frame. Held frames count for
 * their whole hold; with every hold 1 this is simply (index − landing) / count.
 */
export function bouncePhases(durations: readonly number[], landing: number): number[] {
  const holds = durations.map((d) => Math.max(1, d || 1));
  const total = holds.reduce((sum, d) => sum + d, 0);
  const mids: number[] = [];
  let tick = 0;
  for (const d of holds) {
    mids.push(tick + d / 2);
    tick += d;
  }
  const zero = mids[landing] ?? 0;
  return mids.map((m) => ((((m - zero) % total) + total) % total) / total);
}

/** Slider amount (% taller / wider) at bounce phase `t` (see bouncePhases). */
export const bounceAmount = (t: number, strength: number): number =>
  Math.round(bounceAt(t) * strength);

/** How high the hop is at bounce phase t (0 = on the ground, 1 = the top):
 *  a thrown object's parabola, so it moves fast near the ground and hangs at
 *  the top. */
export const hopAt = (t: number): number => {
  const p = ((t % 1) + 1) % 1;
  return 4 * p * (1 - p);
};

/** Hop (canvas px, up) at bounce phase `t`; the landing frame (0) is on the ground. */
export const hopAmount = (t: number, height: number): number =>
  Math.round(hopAt(t) * height * 10) / 10;

/**
 * How far down (canvas px) a stretch to `k` sits when it grows from the
 * middle of the drawing instead of from its feet: from the feet it grows only
 * upward, from the middle half up and half down. Measured from the drawing as
 * drawn (k = 1), so an earlier squash does not change it.
 */
export function midStretchDrop(layer: Layer, k: number): number {
  const feet = squashAnchorPoint(layer, "bottom");
  const mid = squashAnchorPoint(layer, "center");
  const rest = { ...layer, pose: squashPose(layer, 1, feet) };
  const stretched = { ...rest, pose: squashPose(rest, k, feet) };
  return matApply(layerMatrix(rest), mid).y - matApply(layerMatrix(stretched), mid).y;
}

/**
 * Hop (canvas px, up) for a bounce frame squashed from the feet. In the air a
 * stretch grows from the middle, as in classic animation, so the frame is
 * lowered by midStretchDrop, but never below the ground: the frames beside the
 * landing stretch up from the feet. The landing frame stays on the ground.
 *
 * Done through the hop (which each bounce replaces) rather than a different
 * squash anchor, so bouncing again never drifts the drawing.
 */
export function bounceLift(layer: Layer, t: number, strength: number, height: number): number {
  if (t < 1e-9 || t > 1 - 1e-9) return 0;
  const k = amountToStretch(bounceAmount(t, strength));
  const lift = hopAt(t) * height - midStretchDrop(layer, k);
  return Math.round(Math.max(0, lift) * 10) / 10;
}
