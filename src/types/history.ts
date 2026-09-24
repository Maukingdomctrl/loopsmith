import type { Project } from "./project";

export type Snapshot = {
  projectId: string;
  project: Project;
  activeFrame: number;
};