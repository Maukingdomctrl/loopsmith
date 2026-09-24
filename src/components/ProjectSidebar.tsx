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
  showEmojiLibrary: boolean;
  onToggleEmojiLibrary: () => void;
}

function ProjectSidebar({
  projects,
  activeProject,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  showEmojiLibrary,
  onToggleEmojiLibrary,
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
    <aside className="flex h-full w-64 flex-col border-r border-white/10 bg-[#11151D]">
      <div className="flex flex-col gap-4 border-b border-white/10 p-4">
        <div className="flex items-center gap-2 text-white">
          <FolderOpen size={18} />
          <h2 className="text-sm font-semibold">Projects</h2>
        </div>

        <button
          onClick={onCreate}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          <Plus size={16} />
          New Animation
        </button>

        <button
          onClick={onToggleEmojiLibrary}
          className={`mt-2 flex w-full items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium transition ${
            showEmojiLibrary
              ? "bg-indigo-600 text-white"
              : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
          }`}
        >
          😀 Emoji Library
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
                className={`group relative cursor-pointer rounded-xl border p-2 transition ${
                  activeProject === project.id
                    ? "border-indigo-500 bg-indigo-500/10"
                    : "border-white/5 hover:bg-white/5"
                }`}
              >
                <div className="flex gap-3">
                  <div className="h-14 w-14 overflow-hidden rounded-lg bg-zinc-800">
                    {thumbnail ? (
                      <img
                        src={thumbnail}
                        alt={project.name}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-zinc-500">
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
                        className="w-full rounded bg-zinc-900 px-2 py-1 text-sm text-white outline-none ring-1 ring-indigo-500"
                      />
                    ) : (
                      <p
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setEditingId(project.id);
                          setEditingName(project.name);
                        }}
                        className="truncate text-sm font-semibold text-white"
                      >
                        {project.name}
                      </p>
                    )}

                    <p className="text-xs text-zinc-400">
                      {project.frames.length} frames • {project.fps} FPS
                    </p>

                    <p className="mt-1 text-[10px] text-zinc-500">
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
  className="rounded p-1 text-red-400 hover:bg-red-900/30 hover:text-red-300"
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