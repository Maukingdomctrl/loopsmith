/**
 * Layer CRUD, ordering and flags — pure, and total.
 *
 * Every function returns a NEW array and enforces the base-layer invariants
 * itself rather than trusting callers. The UI is not the right place for those
 * checks: keyboard shortcuts, drag-reorder and undo replay all mutate layers,
 * and only one of them has a disabled button to hide behind.
 */

import type { Layer, LayerId, LayerKind } from "@/types/layer";
import { isBaseLayer } from "@/types/layer";
import { IDENTITY_POSE, makePose, sanitizePose } from "@/lib/geometry/pose";
import { clamp01 } from "@/lib/geometry/angle";
import { rectNormalize } from "@/lib/geometry/rect";
import { clamp } from "@/lib/geometry/scalar";
import {
  BASE_LAYER_NAME,
  LAYER_NAME_MAX,
  MAX_LAYERS_PER_FRAME,
} from "./constants";

let seq = 0;
export function createLayerId(): LayerId {
  seq += 1;
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `l_${Date.now().toString(36)}_${seq.toString(36)}_${rand}`;
}

export interface CreateLayerInput {
  readonly kind?: LayerKind;
  readonly name?: string;
  readonly image?: string | null;
  readonly size?: { w: number; h: number };
  readonly pose?: Parameters<typeof makePose>[0];
}

export function createLayer(input: CreateLayerInput = {}): Layer {
  const kind = input.kind ?? "raster";
  return {
    id: createLayerId(),
    kind,
    name: (input.name ?? (kind === "base" ? BASE_LAYER_NAME : "Layer")).slice(
      0,
      LAYER_NAME_MAX
    ),
    image: input.image ?? null,
    size: input.size ?? { w: 0, h: 0 },
    pose: input.pose ? makePose(input.pose) : IDENTITY_POSE,
    crop: null,
    opacity: 1,
    visible: true,
    locked: false,
    blend: "normal",
  };
}

export const createBaseLayer = (input: CreateLayerInput = {}): Layer =>
  createLayer({ ...input, kind: "base", name: BASE_LAYER_NAME });

/* ---------------- lookup ---------------- */

export const findLayer = (layers: readonly Layer[], id: LayerId | null): Layer | null =>
  id ? layers.find((l) => l.id === id) ?? null : null;

export const indexOfLayer = (layers: readonly Layer[], id: LayerId): number =>
  layers.findIndex((l) => l.id === id);

export const baseLayer = (layers: readonly Layer[]): Layer | null =>
  layers.find(isBaseLayer) ?? layers[0] ?? null;

/**
 * Canonical ordering: base first, everything else in its current relative
 * order. Called after every structural mutation so index 0 is always the base
 * regardless of what the caller attempted.
 */
export function enforceLayerOrder(layers: readonly Layer[]): Layer[] {
  const base = layers.filter(isBaseLayer);
  const rest = layers.filter((l) => !isBaseLayer(l));
  // A second base can only arrive from a corrupt document; demote it rather
  // than dropping the pixels.
  const demoted = base.slice(1).map((l) => ({ ...l, kind: "raster" as const }));
  return [...base.slice(0, 1), ...demoted, ...rest];
}

/* ---------------- structure ---------------- */

export function addLayer(
  layers: readonly Layer[],
  layer: Layer,
  aboveId?: LayerId | null
): Layer[] {
  if (layers.length >= MAX_LAYERS_PER_FRAME) return [...layers];
  const safe = isBaseLayer(layer) && layers.some(isBaseLayer)
    ? { ...layer, kind: "raster" as const }
    : layer;

  const next = [...layers];
  const at = aboveId ? indexOfLayer(next, aboveId) : -1;
  if (at >= 0) next.splice(at + 1, 0, safe);
  else next.push(safe);
  return enforceLayerOrder(next);
}

export interface RemoveResult {
  readonly layers: Layer[];
  /** Layer to select afterwards; never null because the base always survives. */
  readonly nextSelectedId: LayerId;
  readonly removed: Layer | null;
}

/** Deleting the base layer is a no-op by contract, not an error: undo replay
 *  and multi-delete both benefit from a total function here. */
export function removeLayer(layers: readonly Layer[], id: LayerId): RemoveResult {
  const idx = indexOfLayer(layers, id);
  const target = idx >= 0 ? layers[idx] : null;
  const base = baseLayer(layers);

  if (!target || isBaseLayer(target) || !base) {
    return { layers: [...layers], nextSelectedId: base?.id ?? id, removed: null };
  }
  const next = layers.filter((l) => l.id !== id);
  const fallback = next[Math.min(idx, next.length - 1)] ?? base;
  return { layers: next, nextSelectedId: fallback.id, removed: target };
}

export function duplicateLayer(layers: readonly Layer[], id: LayerId): {
  layers: Layer[];
  newId: LayerId | null;
} {
  const src = findLayer(layers, id);
  if (!src || layers.length >= MAX_LAYERS_PER_FRAME) {
    return { layers: [...layers], newId: null };
  }
  // A duplicated base becomes a raster copy directly above the base: the base
  // itself must stay unique, but the animator's intent (another copy of these
  // pixels) is still honoured.
  const copy: Layer = {
    ...src,
    id: createLayerId(),
    kind: "raster",
    name: nextCopyName(layers, src.name),
    pose: { ...src.pose },
    crop: src.crop ? { ...src.crop } : null,
    locked: false,
    // A copy in the same frame is a separate layer, not another frame's copy.
    linkId: undefined,
  };
  return { layers: addLayer(layers, copy, id), newId: copy.id };
}

function nextCopyName(layers: readonly Layer[], name: string): string {
  const stem = name.replace(/ copy( \d+)?$/, "");
  let n = 1;
  let candidate = `${stem} copy`;
  const taken = new Set(layers.map((l) => l.name));
  while (taken.has(candidate)) candidate = `${stem} copy ${++n}`;
  return candidate.slice(0, LAYER_NAME_MAX);
}

/**
 * Move a layer to an absolute index.
 *
 * `to` is interpreted in the ORIGINAL indexing (same convention as
 * reorderFrames), and the base layer's slot is excluded from the legal range,
 * so a drag onto the base cannot bury it.
 */
export function moveLayer(
  layers: readonly Layer[],
  id: LayerId,
  to: number
): Layer[] {
  const from = indexOfLayer(layers, id);
  if (from < 0) return [...layers];
  const target = layers[from];
  if (isBaseLayer(target)) return [...layers];

  const next = [...layers];
  next.splice(from, 1);
  const lo = next.findIndex((l) => !isBaseLayer(l));
  const min = lo < 0 ? next.length : lo;
  const insertAt = clamp(from < to ? to - 1 : to, min, next.length);
  next.splice(insertAt, 0, target);
  return enforceLayerOrder(next);
}

export const raiseLayer = (layers: readonly Layer[], id: LayerId): Layer[] =>
  moveLayer(layers, id, indexOfLayer(layers, id) + 2);

export const lowerLayer = (layers: readonly Layer[], id: LayerId): Layer[] =>
  moveLayer(layers, id, indexOfLayer(layers, id) - 1);

export const layerToFront = (layers: readonly Layer[], id: LayerId): Layer[] =>
  moveLayer(layers, id, layers.length);

export const layerToBack = (layers: readonly Layer[], id: LayerId): Layer[] =>
  moveLayer(layers, id, 1);

/* ---------------- flags & properties ---------------- */

export function updateLayer(
  layers: readonly Layer[],
  id: LayerId,
  patch: Partial<Layer>
): Layer[] {
  let changed = false;
  const next = layers.map((l) => {
    if (l.id !== id) return l;
    const merged = mergeLayer(l, patch);
    if (merged === l) return l;
    changed = true;
    return merged;
  });
  return changed ? next : (layers as Layer[]);
}

/** Single validating merge point. `kind` is intentionally not patchable: layer
 *  identity is structural, and letting the UI flip it would let the base
 *  layer be demoted by a rename dialog. */
function mergeLayer(layer: Layer, patch: Partial<Layer>): Layer {
  const next: Layer = {
    ...layer,
    ...patch,
    kind: layer.kind,
    id: layer.id,
    name:
      patch.name !== undefined
        ? (patch.name.trim() || layer.name).slice(0, LAYER_NAME_MAX)
        : layer.name,
    opacity: patch.opacity !== undefined ? clamp01(patch.opacity) : layer.opacity,
    pose: patch.pose ? sanitizePose(patch.pose) : layer.pose,
    crop:
      patch.crop === undefined
        ? layer.crop
        : patch.crop === null
          ? null
          : rectNormalize(patch.crop),
  };
  return shallowEqualLayer(layer, next) ? layer : next;
}

/** Referential-stability check so React can skip untouched rows. */
function shallowEqualLayer(a: Layer, b: Layer): boolean {
  return (
    a.name === b.name &&
    a.image === b.image &&
    a.opacity === b.opacity &&
    a.visible === b.visible &&
    a.locked === b.locked &&
    a.blend === b.blend &&
    a.alphaLock === b.alphaLock &&
    a.clip === b.clip &&
    a.adjust === b.adjust &&
    a.size.w === b.size.w &&
    a.size.h === b.size.h &&
    a.crop === b.crop &&
    a.pose === b.pose
  );
}

export const setLayerVisible = (l: readonly Layer[], id: LayerId, v: boolean) =>
  updateLayer(l, id, { visible: v });

export const toggleLayerVisible = (l: readonly Layer[], id: LayerId) =>
  updateLayer(l, id, { visible: !(findLayer(l, id)?.visible ?? true) });

export const setLayerLocked = (l: readonly Layer[], id: LayerId, v: boolean) =>
  updateLayer(l, id, { locked: v });

export const toggleLayerLocked = (l: readonly Layer[], id: LayerId) =>
  updateLayer(l, id, { locked: !(findLayer(l, id)?.locked ?? false) });

export const setLayerOpacity = (l: readonly Layer[], id: LayerId, v: number) =>
  updateLayer(l, id, { opacity: v });

export const renameLayer = (l: readonly Layer[], id: LayerId, name: string) =>
  updateLayer(l, id, { name });

/** Isolate: show only this layer. Returns the previous visibility map so the
 *  caller can restore it without a second snapshot. */
export function isolateLayer(
  layers: readonly Layer[],
  id: LayerId
): { layers: Layer[]; previous: Record<LayerId, boolean> } {
  const previous: Record<LayerId, boolean> = {};
  const next = layers.map((l) => {
    previous[l.id] = l.visible;
    const visible = l.id === id;
    return l.visible === visible ? l : { ...l, visible };
  });
  return { layers: next, previous };
}
