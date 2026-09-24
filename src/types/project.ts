import { type Frame } from "@/types/frame";
import { createBlankFrame } from "@/lib/frameOps";
import { DEFAULT_BACKGROUND, type CanvasBackground } from "@/types/layer";
import { LAYER_SCHEMA_VERSION } from "@/lib/layers/migrate";

/**
 * Provenance of the last Auto Stabilize run.
 *
 * Exists to make STALENESS detectable. L2 is measured from pixels; if the
 * animator redraws frame 6 after stabilizing, frame 6's correction was computed
 * from bitmap data that no longer exists. Without this record the UI cannot
 * tell a fresh solve from a stale one, and the animator gets a correction that
 * silently no longer matches the art.
 */
export interface StabilizationProvenance {
  readonly algorithmVersion: string;
  /** Per-frame content hashes at solve time, index-aligned. */
  readonly inputHashes: readonly string[];
  /** Fingerprint of constants + options, for reproducibility auditing. */
  readonly constantsFingerprint: string;
  readonly appliedAt: number;
}

export interface Project {
  id: string;
  name: string;
  frames: Frame[];
  fps: number;
  thumbnail: string | null;
  createdAt: number;
  updatedAt: number;
  /** Absent until Auto Stabilize has run at least once. */
  stabilization?: StabilizationProvenance;
    /** Canvas transparency toggle + backdrop colour. Document state: exported. */
  background: CanvasBackground;

  /** Absent on pre-layer projects; migration stamps it. */
  schemaVersion: number;
}

export function createProjectId(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `p_${Date.now().toString(36)}_${rand.slice(0, 8)}`;
}

export function createEmptyProject(name: string): Project {
  const now = Date.now();
  return {
    id: createProjectId(),
    name,
    frames: [createBlankFrame()],
    fps: 12,
    thumbnail: null,
    createdAt: now,
    updatedAt: now,
    background: DEFAULT_BACKGROUND,
    schemaVersion: LAYER_SCHEMA_VERSION,
  };
}

/** True when at least one frame's pixels have changed since the last solve. */
export function isStabilizationStale(
  project: Project,
  currentHashes: readonly string[]
): boolean {
  const prov = project.stabilization;
  if (!prov) return false;
  if (prov.inputHashes.length !== currentHashes.length) return true;
  return prov.inputHashes.some((h, i) => h !== currentHashes[i]);
}
