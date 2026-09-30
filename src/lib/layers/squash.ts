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
import { layerContentBox, layerMatrix } from "./layerSpace";
import { getCachedBitmap } from "./flatten";

export type SquashAnchor = "bottom" | "center" | "top";

/** Height ÷ width factor, relative to the layer's own proportions: 1 = as
 *  drawn, >1 stretched, <1 squashed. */
export function stretchOf(pose: Pose): number {
  const sx = Math.abs(pose.scale.x), sy = Math.abs(pose.scale.y);
  return sx > 0 && sy > 0 ? Math.sqrt(sy / sx) : 1;
}

/** Slider value (−100..100, % taller or wider) ⇄ stretch factor. */
export const stretchToAmount = (k: number) => Math.round((k >= 1 ? k - 1 : 1 - 1 / k) * 100);
export const amountToStretch = (v: number) => (v >= 0 ? 1 + v / 100 : 1 / (1 - v / 100));

/** Bounds of the pixels actually drawn (alpha > 0) in an image, by image. */
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
      if (d[(y * w + x) * 4 + 3] === 0) continue;
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

/**
 * The layer-space point that stays put: the bottom, centre or top of what is
 * actually drawn (so "bottom" means the character's feet, not the empty
 * margin of its cell), falling back to the layer's box.
 */
export function squashAnchorPoint(layer: Layer, anchor: SquashAnchor): Vec2 {
  const box = layerContentBox(layer);
  const drawn = layer.image ? drawnBounds(layer.image) : null;
  const r = drawn ?? box;
  return {
    x: r.x + r.w / 2,
    y: anchor === "bottom" ? r.y + r.h : anchor === "top" ? r.y : r.y + r.h / 2,
  };
}

/** The layer's pose squashed or stretched to factor `k`, area preserved,
 *  flips kept, the layer-space point `local` fixed on the canvas. */
export function squashPose(layer: Layer, k: number, local: Vec2): Pose {
  const { pose } = layer;
  const sx = pose.scale.x, sy = pose.scale.y;
  const area = Math.sqrt(Math.abs(sx * sy));
  const kk = Math.max(0.2, Math.min(5, k));
  const next = makePose({
    ...pose,
    scale: { x: Math.sign(sx || 1) * (area / kk), y: Math.sign(sy || 1) * (area * kk) },
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

/** Slider amount (% taller / wider) for frame `index` of `count`, with frame
 *  `landing` as the squashed contact frame. */
export function bounceAmount(index: number, count: number, landing: number, strength: number): number {
  if (count <= 0) return 0;
  const t = (((index - landing) % count) + count) % count / count;
  return Math.round(bounceAt(t) * strength);
}

/** How high the hop is at bounce phase t (0 = on the ground, 1 = the top):
 *  a thrown object's parabola, so it moves fast near the ground and hangs at
 *  the top. */
export const hopAt = (t: number): number => {
  const p = ((t % 1) + 1) % 1;
  return 4 * p * (1 - p);
};

/** Hop (canvas px, up) for frame `index` of `count`, frame `landing` on the ground. */
export function hopAmount(index: number, count: number, landing: number, height: number): number {
  if (count <= 0) return 0;
  const t = (((index - landing) % count) + count) % count / count;
  return Math.round(hopAt(t) * height * 10) / 10;
}
