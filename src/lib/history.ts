/**
 * Undo/redo persistence.
 *
 * Snapshots hold whole Projects, so L2 rides along automatically — but
 * snapshots written before L2 existed do not have it, and restoring one would
 * reintroduce `stab: undefined` into live state. Normalizing on LOAD keeps that
 * out of the running system entirely, so no consumer needs a null guard.
 */

import type { Snapshot } from "@/types/history";
import { normalizeFrame } from "./frameTransform";
import { normalizeFrameLayers } from "@/lib/layers/migrate";

const KEY = "loop-history-v2";
const LIMIT = 50;

interface StoredHistory {
  undo: Snapshot[];
  redo: Snapshot[];
}

function normalizeSnapshot(s: Snapshot): Snapshot {
  if (!s?.project?.frames) return s;

  const frames = s.project.frames.map((f) =>
    normalizeFrameLayers(normalizeFrame(f))
  );

  return {
    ...s,
    project: {
      ...s.project,
      frames,
    },
  };
}

export function loadHistory(): StoredHistory {
  if (typeof localStorage === "undefined") return { undo: [], redo: [] };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { undo: [], redo: [] };
    const parsed = JSON.parse(raw) as StoredHistory;
    return {
      undo: (parsed.undo ?? []).map(normalizeSnapshot),
      redo: (parsed.redo ?? []).map(normalizeSnapshot),
    };
  } catch {
    return { undo: [], redo: [] };
  }
}

export function saveHistory(
  undo: readonly Snapshot[],
  redo: readonly Snapshot[]
): void {
  if (typeof localStorage === "undefined") return;
  try {
    // Trim before serializing: a 50-deep stack of 24-frame projects with
    // inlined data URLs will exceed the localStorage quota and throw, silently
    // losing ALL history rather than the oldest entry.
    const payload: StoredHistory = {
      undo: undo.slice(-LIMIT).map(stripImages),
      redo: redo.slice(-LIMIT).map(stripImages),
    };
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* quota exhausted and unrecoverable; in-memory history still works */
    }
  }
}

/** Transforms are tiny; bitmaps are not. Images live in IndexedDB keyed by
 *  frame id, so history only needs to remember WHICH image, not its bytes. */
function stripImages(s: Snapshot): Snapshot {
  return {
    ...s,
    project: {
      ...s.project,
      frames: s.project.frames.map((f) => ({
        ...f,
        image: f.image ? "" : null,
        layers: (f.layers ?? []).map((l) => ({
          ...l,
          image: l.image ? "" : null,
        })),
        flattenKey: null,
      })),
    },
  };
}

export function clearHistory(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
