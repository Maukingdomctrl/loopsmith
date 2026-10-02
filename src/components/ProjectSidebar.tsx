"use client";

import { Plus, Pencil, Trash2, FolderOpen } from "lucide-react";
import React, { useState } from "react";
import type { Project } from "@/types/project";

interface ProjectSidebarProps {
  projects: Project[];
  activeProject: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  
}

function ProjectSidebar({
  projects,
  activeProject,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  
}: ProjectSidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const saveRename = (id: string, original: string) => {
    const name = editingName.trim();

    if (name) {
      onRename(id, name);
    } else {
      onRename(id, original);
    }

    setEditingId(null);
    setEditingName("");
  };

  const cancelRename = () => {
    setEditingId(null);
    setEditingName("");
  };

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex flex-col gap-4 border-b border-line p-4">
        <div className="flex items-center gap-2 text-ink">
          <FolderOpen size={18} />
          <h2 className="text-sm font-semibold">Projects</h2>
        </div>

        <button
          onClick={onCreate}
          className="flex w-full items-center justify-center gap-2 rounded-ctrl bg-primary hoverable px-4 py-2 text-sm font-medium text-ink"
        >
          <Plus size={16} />
          New Animation
        </button>

        </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-2">
        {projects.map((project) => {
          const thumbnail =
              project.frames.find((f) => f.image)?.image ?? project.thumbnail;

          return (
            <div key={project.id}>
              <div
                onClick={() => {
                  if (editingId !== project.id) onSelect(project.id);
                }}
                className={`group relative cursor-pointer rounded-panel border p-2 transition ${
                  activeProject === project.id
                    ? "border-transparent selected"
                    : "border-line hover:bg-hover"
                }`}
              >
                <div className="flex gap-3">
                  <div className="h-14 w-14 overflow-hidden rounded-ctrl bg-ctrl">
                    {thumbnail ? (
                      <img
                        src={thumbnail}
                        alt={project.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-ink-3">
                        <FolderOpen size={20} />
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 flex-1 pr-6">
                    {editingId === project.id ? (
                      <input
                        autoFocus
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={() => saveRename(project.id, project.name)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter")
                            saveRename(project.id, project.name);

                          if (e.key === "Escape")
                            cancelRename();
                        }}
                        className="w-full rounded-ctrl bg-panel px-2 py-1 text-sm text-ink outline-none ring-1 ring-accent"
                      />
                    ) : (
                      <p
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setEditingId(project.id);
                          setEditingName(project.name);
                        }}
                        className="truncate text-sm font-semibold text-ink"
                      >
                        {project.name}
                      </p>
                    )}

                    <p className="text-xs text-ink-2">
                      {project.frames.length} frames • {project.fps} FPS
                    </p>

                    <p className="mt-1 text-[11px] text-ink-3">
                      {new Date(project.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>

                {editingId !== project.id && (
                  <div className="absolute right-2 top-2 flex flex-col gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
  onClick={(e) => {
    e.stopPropagation();

    if (
      window.confirm(
        `Delete "${project.name}"?\n\nThis cannot be undone.`
      )
    ) {
      onDelete(project.id);
    }
  }}
  className="rounded-ctrl p-1 text-danger hover:bg-danger-bg hover:text-danger-strong"
  title="Delete"
>
  <Trash2 size={12} />
</button>

                    
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

export default React.memo(ProjectSidebar);