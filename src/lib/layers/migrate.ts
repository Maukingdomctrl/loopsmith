/**
 * Legacy → layered migration.
 *
 * THE COMPATIBILITY CONTRACT. Every frame ever persisted by this app has
 * `{ image, x, y, zoom, rotation, stab }` and no layers. Those five numbers
 * describe exactly one bitmap, so they map onto exactly one base layer — and
 * the map is invertible, which is why the stabilizer and the existing export
 * path keep working without modification.
 *
 * The legacy pose is reconstructed from the documented old semantics:
 *
 *     screen = CANVAS/2 + (x, y) + zoom · fitScale · (u − centre)
 *
 * i.e. translate BEFORE scale, pivot at the bitmap centre, fitted "contain".
 * That is precisely `defaultFitPose` displaced by (x, y) — so migration is a
 * translation, and a round trip through `poseToLegacyFrame` returns the
 * original numbers bit for bit at zoom 1 and to within 1e-9 otherwise.
 */

import type { Frame } from "@/types/frame";
import { ZERO_STABILIZATION } from "@/types/frame";
import type { Layer } from "@/types/layer";
import { DEFAULT_BACKGROUND } from "@/types/layer";
import { CANVAS_SIZE, fitScale } from "@/lib/frameTransform";
import { makePose, type Pose } from "@/lib/geometry/pose";
import { normalizeAngle } from "@/lib/geometry/angle";
import { finiteOr } from "@/lib/geometry/scalar";
import { createBaseLayer, enforceLayerOrder } from "./layerOps";
import { sanitizePose } from "@/lib/geometry/pose";

/** Legacy frame shape, structurally. Kept local so nothing else depends on it. */
interface LegacyFrame {
  id: string;
  image: string | null;
  duration: number;
  x: number;
  y: number;
  zoom: number;
  rotation: number;
  stab?: { dx: number; dy: number };
  layers?: unknown;
}

export interface LegacyPoseInput {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  readonly rotation: number;
  readonly stab?: { readonly dx: number; readonly dy: number };
  readonly width: number;
  readonly height: number;
  readonly surface?: number;
}

/** Legacy transform → Pose. The inverse of `poseToLegacy`. */
export function legacyToPose(input: LegacyPoseInput): Pose {
  const surface = input.surface ?? CANVAS_SIZE;
  const w = Math.max(1, input.width);
  const h = Math.max(1, input.height);
  const fit = fitScale(w, h, surface);
  const s = fit * input.zoom;

  // L2 is in SOURCE pixels and is composed at the render boundary, exactly as
  // frameTransform.renderTransform does — so migration preserves the composed
  // position rather than dropping the correction.
  const stab = input.stab ?? ZERO_STABILIZATION;
  const dx = input.x + stab.dx * s;
  const dy = input.y + stab.dy * s;

  return makePose({
    position: { x: surface / 2 + dx, y: surface / 2 + dy },
    rotation: normalizeAngle(input.rotation),
    scale: { x: s, y: s },
    pivot: { x: w / 2, y: h / 2 },
  });
}

export interface LegacyTransform {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  readonly rotation: number;
}

/**
 * Pose → legacy transform, for the base layer only.
 *
 * Exported so `frameTransform.renderTransform` can keep its exact signature
 * and behaviour: the rest of the app still asks "what are this frame's x/y/
 * zoom/rotation?", and now gets a derived answer instead of a stored one.
 *
 * Returns null when the pose cannot be expressed legacy-style — non-uniform
 * scale or a non-centre pivot. Callers fall back to the layer matrix, which
 * is always correct; only the legacy numeric readout is lost.
 */
export function poseToLegacy(
  pose: Pose,
  width: number,
  height: number,
  surface: number = CANVAS_SIZE
): LegacyTransform | null {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const fit = fitScale(w, h, surface);
  if (!(fit > 0)) return null;

  if (Math.abs(Math.abs(pose.scale.x) - Math.abs(pose.scale.y)) > 1e-6) return null;

  const zoom = Math.abs(pose.scale.x) / fit;
  return {
    x: pose.position.x - surface / 2,
    y: pose.position.y - surface / 2,
    zoom,
    rotation: normalizeAngle(pose.rotation),
  };
}

/* ---------------- frame migration ---------------- */

/**
 * Give a frame a layer stack if it lacks one.
 *
 * Size is unknown until the bitmap decodes, so it starts at 0×0 and the pose
 * is finalized by `attachLayerSize` once the decode lands. Geometry is safe in
 * the interim: a 0×0 content box hit-tests as empty and composites as nothing,
 * rather than as a wrong-sized rectangle.
 */
export function migrateFrame(raw: LegacyFrame): Frame {
  const legacy = raw as LegacyFrame;

  if (Array.isArray(legacy.layers) && legacy.layers.length > 0) {
    return normalizeFrameLayers(legacy as unknown as Frame);
  }

  const base = createBaseLayer({ image: legacy.image ?? null });
  const withPose: Layer = {
    ...base,
    pose: makePose({
      position: { x: CANVAS_SIZE / 2, y: CANVAS_SIZE / 2 },
      rotation: normalizeAngle(finiteOr(legacy.rotation, 0)),
      scale: { x: 1, y: 1 },
      pivot: { x: 0, y: 0 },
    }),
  };

  return {
    id: legacy.id,
    image: legacy.image ?? null,
    duration: Math.max(1, finiteOr(legacy.duration, 1)),
    x: finiteOr(legacy.x, 0),
    y: finiteOr(legacy.y, 0),
    zoom: finiteOr(legacy.zoom, 1) || 1,
    rotation: normalizeAngle(finiteOr(legacy.rotation, 0)),
    stab: legacy.stab
      ? { dx: finiteOr(legacy.stab.dx, 0), dy: finiteOr(legacy.stab.dy, 0) }
      : ZERO_STABILIZATION,
    layers: [withPose],
    activeLayerId: withPose.id,
    crop: null,
    flattenKey: null,
    flattenedAt: 0,
    /** Set once the base bitmap decodes; until then the legacy fields are the
     *  authority and `syncBaseFromLegacy` rebuilds the pose. */
    legacyPosePending: !!legacy.image,
  };
}

/**
 * Finalize a migrated base layer once its bitmap size is known.
 *
 * This is the step that makes migration lossless. Called from the decode path
 * in Canvas; idempotent, so repeated decodes are harmless.
 */
export function attachLayerSize(
  frame: Frame,
  layerId: string,
  width: number,
  height: number
): Frame {
  const idx = frame.layers.findIndex((l) => l.id === layerId);
  if (idx < 0) return frame;
  const layer = frame.layers[idx];
  if (layer.size.w === width && layer.size.h === height && !frame.legacyPosePending) {
    return frame;
  }

  const isBase = layer.kind === "base";
  const pose =
    isBase && frame.legacyPosePending
      ? legacyToPose({
          x: frame.x,
          y: frame.y,
          zoom: frame.zoom,
          rotation: frame.rotation,
          stab: frame.stab,
          width,
          height,
        })
      : layer.pose.pivot.x === 0 && layer.pose.pivot.y === 0 && layer.size.w === 0
        ? makePose({
            position: layer.pose.position,
            rotation: layer.pose.rotation,
            scale: layer.pose.scale,
            pivot: { x: width / 2, y: height / 2 },
          })
        : layer.pose;

  const layers = [...frame.layers];
  layers[idx] = { ...layer, size: { w: width, h: height }, pose };

  return {
    ...frame,
    layers,
    legacyPosePending: isBase ? false : frame.legacyPosePending,
  };
}

/**
 * Push the base layer's pose back into the legacy fields.
 *
 * Runs after every layer mutation. It is what keeps the stabilizer, the GIF
 * exporter's per-frame transform and the "Live Values" readout correct without
 * any of them knowing layers exist. L2 is deliberately NOT folded in: `stab`
 * stays machine-owned and is composed at render time, preserving the
 * idempotence the stabilizer depends on.
 */
export function syncBaseFromLegacy(frame: Frame): Frame {
  const base = frame.layers.find((l) => l.kind === "base");
  if (!base || base.size.w === 0) return frame;

  const legacy = poseToLegacy(base.pose, base.size.w, base.size.h);
  if (!legacy) return frame;

  const stab = frame.stab ?? ZERO_STABILIZATION;
  const s = fitScale(Math.max(1, base.size.w), Math.max(1, base.size.h)) * legacy.zoom;
  // Subtract the composed L2 so that x/y remain pure L1, exactly as before.
  const x = legacy.x - stab.dx * s;
  const y = legacy.y - stab.dy * s;

  if (
    Math.abs(frame.x - x) < 1e-9 &&
    Math.abs(frame.y - y) < 1e-9 &&
    Math.abs(frame.zoom - legacy.zoom) < 1e-12 &&
    Math.abs(frame.rotation - legacy.rotation) < 1e-9
  ) {
    return frame;
  }
  return { ...frame, x, y, zoom: legacy.zoom, rotation: legacy.rotation };
}

/** Repair a layer array from persistence: sanitize poses, enforce the base
 *  invariant, guarantee an active id. Never throws. */
export function normalizeFrameLayers(frame: Frame): Frame {
  const raw = Array.isArray(frame.layers) ? frame.layers : [];
  const repaired = raw.map((l, i) => ({
    ...l,
    id: l.id ?? `l_recovered_${i}`,
    kind: l.kind === "base" ? "base" : l.kind === "group" ? ("group" as const) : ("raster" as const),
    name: typeof l.name === "string" && l.name ? l.name : `Layer ${i + 1}`,
    size: {
      w: Math.max(0, finiteOr(l.size?.w, 0)),
      h: Math.max(0, finiteOr(l.size?.h, 0)),
    },
    pose: sanitizePose(l.pose),
    crop: l.crop ?? null,
    opacity: Math.min(1, Math.max(0, finiteOr(l.opacity, 1))),
    visible: l.visible !== false,
    locked: l.locked === true,
    blend: l.blend ?? "normal",
  })) as Layer[];

  const layers = repaired.length
    ? enforceLayerOrder(repaired)
    : [createBaseLayer({ image: frame.image ?? null })];

  // A document with no base at all (hand-edited or truncated) gets its bottom
  // layer promoted rather than a new empty base inserted, which would bury the
  // artwork behind a blank base.
  const withBase = layers.some((l) => l.kind === "base")
    ? layers
    : [{ ...layers[0], kind: "base" as const }, ...layers.slice(1)];

  const activeLayerId = withBase.some((l) => l.id === frame.activeLayerId)
    ? frame.activeLayerId
    : withBase[withBase.length - 1].id;

  return {
    ...frame,
    layers: withBase,
    activeLayerId,
    crop: frame.crop ?? null,
    stab: frame.stab ?? ZERO_STABILIZATION,
    flattenKey: frame.flattenKey ?? null,
    flattenedAt: frame.flattenedAt ?? 0,
    legacyPosePending: frame.legacyPosePending ?? false,
  };
}

export const migrateFrames = (frames: readonly unknown[]): Frame[] =>
  frames.map((f) => migrateFrame(f as LegacyFrame));

export const DEFAULT_PROJECT_BACKGROUND = DEFAULT_BACKGROUND;
export const LAYER_SCHEMA_VERSION = 3;
