import type { Project } from "@/types/project";

const KEY = "loop-projects";
const ACTIVE_KEY = "loop-active-project";

type StoredProject = Omit<Project, "frames"> & {
  frames: Omit<Project["frames"][number], "image">[];
};

export function loadProjects(): StoredProject[] {
  if (typeof window === "undefined") return [];

  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];

    const parsed = JSON.parse(raw);

    return parsed.map((project: any) => ({
      ...project,
      thumbnail: project.thumbnail ?? null,
      frames: (project.frames ?? []).map((frame: any) => ({
  id: frame.id ?? crypto.randomUUID(),
  x: frame.x ?? 0,
  y: frame.y ?? 0,
  zoom: frame.zoom ?? 1,
  rotation: frame.rotation ?? 0,
  duration: frame.duration ?? 1,
  stab: frame.stab ?? { dx: 0, dy: 0 },
  layers: frame.layers ?? [],
  activeLayerId: frame.activeLayerId ?? "",
  crop: frame.crop ?? null,

  transparency: frame.transparency ?? null,

  flattenKey: frame.flattenKey ?? "",
  flattenedAt: frame.flattenedAt ?? 0,
  legacyPosePending: frame.legacyPosePending ?? false,
})),
    }));
  } catch {
    return [];
  }
}

export function saveProjects(projects: Project[]) {
  if (typeof window === "undefined") return;

  const lightweight: StoredProject[] = projects.map((project) => ({
    id: project.id,
    name: project.name,
    thumbnail: project.thumbnail,
    fps: project.fps,

    background: project.background,
    schemaVersion: project.schemaVersion,


    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    frames: project.frames.map((frame) => ({
  id: frame.id,
  x: frame.x,
  y: frame.y,
  zoom: frame.zoom,
  rotation: frame.rotation,
  duration: frame.duration,
  stab: frame.stab,

  layers: frame.layers,
  activeLayerId: frame.activeLayerId,
  crop: frame.crop,

  
  transparency: frame.transparency,


  flattenKey: frame.flattenKey,
  flattenedAt: frame.flattenedAt,
  legacyPosePending: frame.legacyPosePending,
})),
  }));

  localStorage.setItem(KEY, JSON.stringify(lightweight));
}

export function updateProjectTimestamp(project: Project): Project {
  return {
    ...project,
    updatedAt: Date.now(),
    thumbnail:
      project.frames.find((f) => f.image)?.image ?? null,
  };
}
export function loadActiveProjectId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACTIVE_KEY);
}

export function saveActiveProjectId(id: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(ACTIVE_KEY, id);
}