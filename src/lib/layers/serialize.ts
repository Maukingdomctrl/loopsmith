/**
 * Persistence encoding.
 *
 * Bitmaps NEVER travel inside the project record. Each layer's pixels live in
 * IndexedDB under `${projectId}-${frameId}-${layerId}`, and the project stores
 * a marker. The old code did this for `frame.image`; layers make it
 * load-bearing rather than merely tidy, since a 24-frame project with four
 * layers each would otherwise serialize tens of megabytes of base64 on every
 * debounced save.
 */

import type { Frame } from "@/types/frame";
import type { Project } from "@/types/project";
import type { Layer } from "@/types/layer";
import { normalizeFrameLayers, migrateFrame, LAYER_SCHEMA_VERSION } from "./migrate";
import { DEFAULT_BACKGROUND } from "@/types/layer";

/** Sentinel meaning "pixels exist in IndexedDB". Distinct from null, which
 *  means "this layer genuinely has no bitmap". */
export const IMAGE_REF = "\u0000ref";

export const layerImageKey = (
  projectId: string,
  frameId: string,
  layerId: string
): string => `${projectId}-${frameId}-${layerId}`;

/** Strip bitmaps for storage, preserving the has-image/no-image distinction. */
export function encodeFrame(frame: Frame): Frame {
  return {
    ...frame,
    image: frame.image ? IMAGE_REF : null,
    layers: frame.layers.map((l) => ({
      ...l,
      image: l.image ? IMAGE_REF : null,
    })),
  };
}

export const encodeProject = (project: Project): Project => ({
  ...project,
  schemaVersion: LAYER_SCHEMA_VERSION,
  background: project.background ?? DEFAULT_BACKGROUND,
  thumbnail: null,
  frames: project.frames.map(encodeFrame),
});

export const encodeProjects = (projects: readonly Project[]): Project[] =>
  projects.map(encodeProject);

/** Reverse: run migration, then attach the hydrated bitmaps. */
export function decodeFrame(
  raw: unknown,
  images: ReadonlyMap<string, string | null>,
  projectId: string
): Frame {
  // Frames saved before the old per-frame transparency mask was removed may
  // still carry it; drop it so it is not kept (or re-saved) invisibly.
  const stored = { ...(raw as Record<string, unknown>) };
  delete stored.transparency;
  const migrated = normalizeFrameLayers(migrateFrame(stored as never));

  const layers: Layer[] = migrated.layers.map((l) => {
    const stored = images.get(layerImageKey(projectId, migrated.id, l.id));
    // A missing blob for a layer that claimed one is a partial write; keep the
    // layer (its geometry is still meaningful) with no pixels rather than
    // dropping it and silently changing the stack order.
    return { ...l, image: stored ?? null };
  });

  const baseImage = layers.find((l) => l.kind === "base")?.image ?? null;
  return {
    ...migrated,
    layers,
    image: migrated.image === IMAGE_REF ? baseImage : migrated.image,
    // Force a recomposite on load: the cache key cannot be trusted across a
    // schema change or a partial write.
    flattenKey: null,
  };
}

export function decodeProject(
  raw: Project,
  images: ReadonlyMap<string, string | null>
): Project {
  const frames = (raw.frames ?? []).map((f) => decodeFrame(f, images, raw.id));
  return {
    ...raw,
    schemaVersion: LAYER_SCHEMA_VERSION,
    background: raw.background ?? DEFAULT_BACKGROUND,
    frames,
    thumbnail: frames.find((f) => f.image)?.image ?? null,
  };
}

/** Every (key, dataURL) pair a project needs written. Diffed against the last
 *  write so unchanged layers are not re-serialized. */
export function collectLayerImages(
  project: Project
): Map<string, string> {
  const out = new Map<string, string>();
  for (const frame of project.frames) {
    for (const layer of frame.layers) {
      if (layer.image && layer.image !== IMAGE_REF) {
        out.set(layerImageKey(project.id, frame.id, layer.id), layer.image);
      }
    }
  }
  return out;
}

/** Keys that should exist. Anything else under the project prefix is garbage
 *  from deleted layers and is collected. */
export function liveLayerKeys(project: Project): Set<string> {
  return new Set(collectLayerImages(project).keys());
}
