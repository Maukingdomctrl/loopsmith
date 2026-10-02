/**
 * Layer groups — pure, and total.
 *
 * A group is a `kind: "group"` entry in the ordinary bottom-to-top layer
 * array; its layers point at it through `parentId`. One invariant makes the
 * array read as a tree: a group's layers sit contiguously DIRECTLY BELOW the
 * group entry. `normalizeGroups` restores it after every structural edit, so
 * callers only ever set `parentId` and an approximate position.
 *
 * Groups pass blend modes through. For drawing, `resolveGroups` drops the
 * group entries and folds each group's visibility and opacity into its layers,
 * so the compositor sees a flat stack and frames without groups draw exactly
 * as before.
 */

import type { Layer, LayerId } from "@/types/layer";
import { isBaseLayer, isGroupLayer } from "@/types/layer";

/** Ancestors of a layer, nearest first. Stops on a broken or cyclic chain. */
export function ancestorsOf(layers: readonly Layer[], layer: Layer): Layer[] {
  const out: Layer[] = [];
  const seen = new Set<LayerId>([layer.id]);
  let parentId = layer.parentId;
  while (parentId && !seen.has(parentId)) {
    const parent = layers.find((l) => l.id === parentId);
    if (!parent || !isGroupLayer(parent)) break;
    out.push(parent);
    seen.add(parent.id);
    parentId = parent.parentId;
  }
  return out;
}

/** True when `id` is `groupId` itself or sits anywhere inside it. */
export function isInside(layers: readonly Layer[], id: LayerId, groupId: LayerId): boolean {
  if (id === groupId) return true;
  const layer = layers.find((l) => l.id === id);
  return !!layer && ancestorsOf(layers, layer).some((a) => a.id === groupId);
}

/** Every layer inside a group, at any depth. */
export function descendantIds(layers: readonly Layer[], groupId: LayerId): Set<LayerId> {
  const out = new Set<LayerId>();
  for (const l of layers) {
    if (l.id !== groupId && isInside(layers, l.id, groupId)) out.add(l.id);
  }
  return out;
}

/** Direct children of a group, top first (as the panel lists them). */
export function childrenOf(layers: readonly Layer[], groupId: LayerId): Layer[] {
  return layers.filter((l) => l.parentId === groupId).reverse();
}

/**
 * Restore the tree invariant: base first; every group's layers directly
 * below it, in their current relative order. Also repairs what a corrupt or
 * hand-edited document can contain: a parent that is missing, not a group, or
 * part of a cycle is dropped, so the layer lands at the top level.
 */
export function normalizeGroups(layers: readonly Layer[]): Layer[] {
  const hasGroups = layers.some((l) => isGroupLayer(l) || l.parentId);
  if (!hasGroups) return [...layers];

  const byId = new Map(layers.map((l) => [l.id, l]));
  const validParent = (l: Layer): LayerId | undefined => {
    if (isBaseLayer(l) || !l.parentId) return undefined;
    const p = byId.get(l.parentId);
    if (!p || !isGroupLayer(p)) return undefined;
    // Cycle check: walking up from the parent must never reach `l`.
    const seen = new Set<LayerId>([l.id]);
    let cur: Layer | undefined = p;
    while (cur) {
      if (seen.has(cur.id)) return undefined;
      seen.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return p.id;
  };

  const fixed = layers.map((l) => {
    const parentId = validParent(l);
    if (parentId === l.parentId) return l;
    const { parentId: _drop, ...rest } = l;
    void _drop;
    return parentId ? { ...rest, parentId } : (rest as Layer);
  });

  const base = fixed.filter(isBaseLayer);
  const rest = fixed.filter((l) => !isBaseLayer(l));

  // Children per parent, TOP first — the panel's reading order.
  const kids = new Map<LayerId | "", Layer[]>();
  for (let i = rest.length - 1; i >= 0; i--) {
    const l = rest[i];
    const key = l.parentId ?? "";
    const list = kids.get(key);
    if (list) list.push(l);
    else kids.set(key, [l]);
  }

  const topFirst: Layer[] = [];
  const emit = (key: LayerId | "") => {
    for (const l of kids.get(key) ?? []) {
      topFirst.push(l);
      if (isGroupLayer(l)) emit(l.id);
    }
  };
  emit("");

  return [...base, ...topFirst.reverse()];
}

/**
 * The flat stack the compositor draws: no group entries, and each layer's
 * visibility and opacity multiplied by its groups'. Returns the SAME array
 * when the frame has no groups, so nothing about those frames changes.
 */
export function resolveGroups(layers: readonly Layer[]): readonly Layer[] {
  if (!layers.some(isGroupLayer)) return layers;
  const out: Layer[] = [];
  for (const l of layers) {
    if (isGroupLayer(l)) continue;
    const ancestors = ancestorsOf(layers, l);
    if (ancestors.length === 0) {
      out.push(l);
      continue;
    }
    const visible = l.visible && ancestors.every((a) => a.visible);
    const opacity = ancestors.reduce((o, a) => o * a.opacity, l.opacity);
    out.push(visible === l.visible && opacity === l.opacity ? l : { ...l, visible, opacity });
  }
  return out;
}

/** Where a layer and everything inside it starts in the array. */
function blockStart(layers: readonly Layer[], index: number): number {
  const layer = layers[index];
  if (!isGroupLayer(layer)) return index;
  return index - descendantIds(layers, layer.id).size;
}

/** Move `id` to array slot `at` (computed after it is removed) with a new parent. */
function placeAt(layers: readonly Layer[], id: LayerId, at: number, parentId: LayerId | undefined): Layer[] {
  const from = layers.findIndex((l) => l.id === id);
  if (from < 0) return [...layers];
  const moving = layers[from];
  const next = [...layers];
  next.splice(from, 1);
  const insertAt = Math.max(1, Math.min(at > from ? at - 1 : at, next.length));
  const { parentId: _old, ...rest } = moving;
  void _old;
  next.splice(insertAt, 0, parentId ? { ...rest, parentId } : (rest as Layer));
  return normalizeGroups(next);
}

/**
 * Drag-and-drop in the panel. Dropped on a group with `into`: becomes its top
 * layer. Otherwise: lands just above `targetId`, beside it in the same group.
 * A group cannot be dropped into itself or its own contents.
 */
export function dropLayer(
  layers: readonly Layer[],
  id: LayerId,
  targetId: LayerId,
  into: boolean
): Layer[] {
  const moving = layers.find((l) => l.id === id);
  const target = layers.find((l) => l.id === targetId);
  if (!moving || !target || isBaseLayer(moving) || id === targetId) return [...layers];
  if (isInside(layers, targetId, id)) return [...layers];

  const t = layers.indexOf(target);
  if (isBaseLayer(target)) return placeAt(layers, id, 1, undefined);
  if (into && isGroupLayer(target)) return placeAt(layers, id, t, target.id);
  return placeAt(layers, id, t + 1, target.parentId);
}

/** One step up among the layers that share its group (a group moves whole). */
export function raiseInGroup(layers: readonly Layer[], id: LayerId): Layer[] {
  const i = layers.findIndex((l) => l.id === id);
  const layer = layers[i];
  if (!layer || isBaseLayer(layer)) return [...layers];
  const above = layers.findIndex((l, j) => j > i && l.parentId === layer.parentId && !isBaseLayer(l));
  if (above < 0) return [...layers];
  return placeAt(layers, id, above + 1, layer.parentId);
}

/** One step down among the layers that share its group. */
export function lowerInGroup(layers: readonly Layer[], id: LayerId): Layer[] {
  const i = layers.findIndex((l) => l.id === id);
  const layer = layers[i];
  if (!layer || isBaseLayer(layer)) return [...layers];
  let below = -1;
  for (let j = blockStart(layers, i) - 1; j >= 0; j--) {
    const l = layers[j];
    if (isBaseLayer(l)) break;
    if (l.parentId === layer.parentId) { below = j; break; }
  }
  if (below < 0) return [...layers];
  return placeAt(layers, id, blockStart(layers, below), layer.parentId);
}

/**
 * Put `ids` into a new group. The group takes the place of the topmost of
 * them, in that layer's group; layers already inside another chosen group go
 * along with it rather than being pulled out of it.
 */
export function groupLayers(layers: readonly Layer[], ids: readonly LayerId[], group: Layer): Layer[] {
  const chosen = new Set(ids);
  const roots = layers.filter(
    (l) =>
      chosen.has(l.id) &&
      !isBaseLayer(l) &&
      !ancestorsOf(layers, l).some((a) => chosen.has(a.id))
  );
  if (roots.length === 0) return [...layers];

  const top = roots[roots.length - 1];
  const topIdx = layers.indexOf(top);
  const rootIds = new Set(roots.map((l) => l.id));
  const next = layers.map((l) => (rootIds.has(l.id) ? { ...l, parentId: group.id } : l));
  const { parentId: _p, ...plain } = group;
  void _p;
  next.splice(topIdx + 1, 0, top.parentId ? { ...plain, parentId: top.parentId } : (plain as Layer));
  return normalizeGroups(next);
}

/** Dissolve a group: its layers move up into the group it was in. */
export function ungroupLayer(layers: readonly Layer[], groupId: LayerId): Layer[] {
  const group = layers.find((l) => l.id === groupId);
  if (!group || !isGroupLayer(group)) return [...layers];
  const next = layers
    .filter((l) => l.id !== groupId)
    .map((l) => {
      if (l.parentId !== groupId) return l;
      const { parentId: _p, ...rest } = l;
      void _p;
      return group.parentId ? { ...rest, parentId: group.parentId } : (rest as Layer);
    });
  return normalizeGroups(next);
}
