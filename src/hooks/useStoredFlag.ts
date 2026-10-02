"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * A boolean kept in localStorage (view preference, e.g. a panel being open).
 * Reads through useSyncExternalStore so the server render and the first
 * client render agree (both use `fallback`), then the stored value applies.
 */
const listeners = new Set<() => void>();
/** Session copy, so toggling still works when storage is blocked. */
const memory = new Map<string, boolean>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

function read(key: string, fallback: boolean): boolean {
  const session = memory.get(key);
  if (session !== undefined) return session;
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

export function useStoredFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => read(key, fallback),
    () => fallback
  );
  const set = useCallback(
    (next: boolean) => {
      memory.set(key, next);
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // Storage blocked: the session copy above still applies.
      }
      listeners.forEach((l) => l());
    },
    [key]
  );
  return [value, set];
}
