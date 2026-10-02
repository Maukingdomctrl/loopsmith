"use client";

import { Plus, Trash2, Image as ImageIcon } from "lucide-react";
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
    <aside className="flex h-full w-[248px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex flex-col gap-4 px-3 pb-3 pt-5">
        <div className="flex items-center justify-between px-1">
          <h2 className="section-title">Projects</h2>
          <span className="font-mono text-[11px] text-ink-3">{projects.length}</span>
        </div>

        <button
          onClick={onCreate}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-ctrl border border-line bg-ctrl px-4 text-[14px] font-medium text-ink hoverable"
        >
          <Plus size={16} className="text-icon" />
          New animation
        </button>
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto px-3 pb-4">
        {projects.map((project) => {
          const thumbnail =
              project.frames.find((f) => f.image)?.image ?? project.thumbnail;
          const isActive = activeProject === project.id;
          const frameCount = project.frames.length;

          return (
            <div
              key={project.id}
              onClick={() => {
                if (editingId !== project.id) onSelect(project.id);
              }}
              className={`group relative flex cursor-pointer items-center gap-3 rounded-card py-2 pl-2 pr-8 ${
                isActive
                  ? "bg-select shadow-[inset_2px_0_0_var(--color-accent)]"
                  : "hoverable"
              }`}
            >
              <div className="h-12 w-12 shrink-0 overflow-hidden rounded-card bg-ctrl">
                {thumbnail ? (
                  <img
                    src={thumbnail}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-icon">
                    <ImageIcon size={18} />
                  </div>
                )}
              </div>

              <div className="min-w-0 flex-1">
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
                    aria-label="Project name"
                    className="w-full rounded-ctrl bg-ctrl px-2 py-1 text-[14px] text-ink outline-none ring-1 ring-select-line"
                  />
                ) : (
                  <p
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setEditingId(project.id);
                      setEditingName(project.name);
                    }}
                    title="Double-click to rename"
                    className={`truncate text-[14px] text-ink ${isActive ? "font-bold" : "font-semibold"}`}
                  >
                    {project.name}
                  </p>
                )}

                <p className="text-[12px] text-ink-2">
                  <span className="font-mono">{frameCount}</span> frame{frameCount === 1 ? "" : "s"} ·{" "}
                  <span className="font-mono">{project.fps}</span> fps
                </p>
              </div>

              {editingId !== project.id && (
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
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-ctrl p-1.5 text-danger opacity-0 transition-opacity hover:bg-danger-bg hover:text-danger-strong focus-visible:opacity-100 group-hover:opacity-100"
                  title="Delete project"
                  aria-label={`Delete ${project.name}`}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

export default React.memo(ProjectSidebar);