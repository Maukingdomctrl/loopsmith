/**
 * Selection set algebra, plus the derived geometry the transform tools need.
 *
 * Selection is EDITOR state, not document state: it is not persisted and not
 * part of undo. `activeLayerId` on the frame is document state (it decides
 * where an import lands) and is persisted; the two are kept in sync but are
 * not the same thing.
 */

import type { Layer, LayerId, LayerSelection } from "@/types/layer";
import { EMPTY_SELECTION, isGroupLayer, isLockedIn } from "@/types/layer";
import { ancestorsOf } from "./groups";
import type { Rect, Vec2 } from "@/types/geometry";
import { RECT_EMPTY, rectCenter, rectIsEmpty, rectUnionAll } from "@/lib/geometry/rect";
import { layerBoundsCanvas, layerContentBox } from "./layerSpace";
import { findLayer } from "./layerOps";

export function selectOnly(id: LayerId | null): LayerSelection {
  return id ? { primary: id, ids: [id] } : EMPTY_SELECTION;
}

export function selectToggle(sel: LayerSelection, id: LayerId): LayerSelection {
  if (sel.ids.includes(id)) {
    const ids = sel.ids.filter((x) => x !== id);
    return { ids, primary: sel.primary === id ? ids[ids.length - 1] ?? null : sel.primary };
  }
  return { ids: [...sel.ids, id], primary: id };
}

export function selectAdd(sel: LayerSelection, id: LayerId): LayerSelection {
  return sel.ids.includes(id) ? { ...sel, primary: id } : { ids: [...sel.ids, id], primary: id };
}

/** Contiguous range between the primary and `id`, in stack order. */
export function selectRange(
  layers: readonly Layer[],
  sel: LayerSelection,
  id: LayerId
): LayerSelection {
  const a = layers.findIndex((l) => l.id === (sel.primary ?? id));
  const b = layers.findIndex((l) => l.id === id);
  if (a < 0 || b < 0) return selectOnly(id);
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return { ids: layers.slice(lo, hi + 1).map((l) => l.id), primary: id };
}

export const selectAll = (layers: readonly Layer[]): LayerSelection => ({
  ids: layers.map((l) => l.id),
  primary: layers[layers.length - 1]?.id ?? null,
});

/** Drop ids that no longer exist. Runs after every undo/redo and after every
 *  frame switch — a stale id would otherwise silently transform nothing.
 */
export function pruneSelection(
  layers: readonly Layer[],
  sel: LayerSelection
): LayerSelection {
  const live = new Set(layers.map((l) => l.id));
  const ids = sel.ids.filter((id) => live.has(id));

  if (
    ids.length === sel.ids.length &&
    (!sel.primary || live.has(sel.primary))
  ) {
    return sel;
  }

  const primary =
    sel.primary && live.has(sel.primary)
      ? sel.primary
      : ids[ids.length - 1] ?? null;

  return { ids, primary };
}


/** The layers a selection stands for: a selected group means everything
 *  inside it (the group entry itself has no pixels to move). */
export const selectedLayers = (
  layers: readonly Layer[],
  sel: LayerSelection
): Layer[] =>
  layers.filter(
    (l) =>
      !isGroupLayer(l) &&
      (sel.ids.includes(l.id) || ancestorsOf(layers, l).some((a) => sel.ids.includes(a.id)))
  );

/** True when `id`, or a group it sits in, is selected. */
export const isCoveredBySelection = (
  layers: readonly Layer[],
  sel: LayerSelection,
  id: LayerId
): boolean => {
  if (sel.ids.includes(id)) return true;
  const layer = layers.find((l) => l.id === id);
  return !!layer && ancestorsOf(layers, layer).some((a) => sel.ids.includes(a.id));
};

/** The layers a transform may actually touch. Locked layers stay selected —
 *  so their properties remain inspectable — but are never moved, and neither
 *  is anything inside a locked group. */
export const transformableLayers = (
  layers: readonly Layer[],
  sel: LayerSelection
): Layer[] => selectedLayers(layers, sel).filter((l) => !isLockedIn(layers, l));

export const primaryLayer = (
  layers: readonly Layer[],
  sel: LayerSelection
): Layer | null => findLayer(layers, sel.primary);

/* ---------------- derived geometry ---------------- */

/** Canvas-space AABB of the selection. Empty when nothing transformable is
 *  selected, which the overlay uses to decide whether to draw at all. */
export function selectionBounds(
  layers: readonly Layer[],
  sel: LayerSelection
): Rect {
  const rects = transformableLayers(layers, sel).map(layerBoundsCanvas);
  return rects.length ? rectUnionAll(rects) : RECT_EMPTY;
}

/**
 * The pivot a group transform rotates about.
 *
 * Single selection → that layer's own pivot, so the dial and the marker agree.
 * Multi selection → the centre of the union AABB, because there is no
 * meaningful "shared local pivot" and the AABB centre is the only choice that
 * is invariant to selection order.
 */
export function selectionPivotCanvas(
  layers: readonly Layer[],
  sel: LayerSelection
): Vec2 | null {
  const items = transformableLayers(layers, sel);
  if (items.length === 0) return null;
  if (items.length === 1) {
    const l = items[0];
    return {
      x: l.pose.position.x,
      y: l.pose.position.y,
    };
  }
  const b = selectionBounds(layers, sel);
  return rectIsEmpty(b) ? null : rectCenter(b);
}

/** Local content box of the primary layer — what the handles are drawn around
 *  in the single-selection case. */
export function primaryContentBox(
  layers: readonly Layer[],
  sel: LayerSelection
): Rect | null {
  const l = primaryLayer(layers, sel);
  return l ? layerContentBox(l) : null;
}