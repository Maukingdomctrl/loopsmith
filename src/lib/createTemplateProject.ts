import type { EmojiTemplate } from "./templateTypes";
import type { Project } from "@/types/project";
import { normalizeFrames } from "@/lib/frameTransform";
import { ZERO_STABILIZATION } from "@/types/frame";
import { DEFAULT_BACKGROUND } from "@/types/layer";

export function createTemplateProject(
  template: EmojiTemplate,
  name?: string
): Project {
  const now = Date.now();

  return {
    id: crypto.randomUUID(),
    name: name ?? template.name,
    thumbnail: template.preview,
    fps: template.animation.fps,

    // Layer System v3
    background: DEFAULT_BACKGROUND,
    schemaVersion: 3,

    frames: normalizeFrames(
      Array.from(
        { length: template.animation.defaultFrames },
        () => ({
          id: crypto.randomUUID(),

          image: null,

          x: 0,
          y: template.geometry.centerY,
          zoom: template.geometry.defaultScale,
          rotation: 0,

          duration: 1,
          stab: ZERO_STABILIZATION,

          // Required v3 fields
          layers: [],
          activeLayerId: "",
          crop: null,
          transparency: null,
          flattenKey: "",
          rasterVersion: 1,
          flattenedAt: 0,
          legacyPosePending: false,
        })
      )
    ),

    createdAt: now,
    updatedAt: now,
  };
}