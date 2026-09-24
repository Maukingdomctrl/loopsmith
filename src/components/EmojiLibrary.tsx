"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Smile,
  Cat,
  PartyPopper,
  Type,
} from "lucide-react";

import { templateRegistry, categories } from "@/lib/templateRegistry";
import type { GeometryPreset } from "@/lib/geometryPresets";

const iconMap = {
  face: Smile,
  animal: Cat,
  dance: PartyPopper,
  text: Type,
};

interface Props {
  onApplyGeometry: (preset: GeometryPreset) => void;
  onCreateProject: (templateId: string) => void;
}

export default function EmojiLibrary({
  onApplyGeometry,
  onCreateProject,
}: Props) {
  const [open, setOpen] = useState("face");
  const [brokenImages, setBrokenImages] = useState<Set<string>>(new Set());

  return (
    <aside className="w-56 border-r border-white/10 bg-[#131720] p-3 overflow-y-auto">
      <h2 className="mb-4 text-sm font-semibold text-white">
        Emoji Library
      </h2>

      <div className="space-y-3">
        {categories.map((category) => {
          const Icon = iconMap[category.id];
          const expanded = open === category.id;

          const templates = templateRegistry.filter(
            (t) => t.category === category.id
          );

          return (
            <div key={category.id}>
              <button
                onClick={() => setOpen(expanded ? "" : category.id)}
                className="flex w-full items-center justify-between rounded-lg px-2 py-2 hover:bg-white/5"
              >
                <div className="flex items-center gap-2">
                  <Icon size={17} className="text-zinc-300" />
                  <span className="text-sm font-medium text-white">
                    {category.name}
                  </span>
                </div>

                {expanded ? (
                  <ChevronDown size={16} className="text-zinc-500" />
                ) : (
                  <ChevronRight size={16} className="text-zinc-500" />
                )}
              </button>

              {expanded && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {templates.map((template) => (
                    <div
                      key={template.id}
                      className="rounded-xl border border-white/5 bg-[#1B202C] p-2"
                    >
                      <div className="mb-2 aspect-square overflow-hidden rounded-lg bg-[#262D3D] flex items-center justify-center">
                        {brokenImages.has(template.id) ? (
                          <span className="text-3xl">🙂</span>
                        ) : (
                          <img
                            src={template.preview}
                            alt={template.name}
                            className="h-full w-full object-cover"
                            draggable={false}
                            onError={() =>
                              setBrokenImages((prev) =>
                                new Set(prev).add(template.id)
                              )
                            }
                          />
                        )}
                      </div>

                      <div className="truncate text-xs font-medium text-white">
                        {template.name}
                      </div>

                      <div className="mt-1 text-[10px] text-zinc-400">
                        {template.animation.defaultFrames} frames
                      </div>

                      <div className="mt-2 grid grid-cols-2 gap-1">
                        <button
                          onClick={() => onApplyGeometry(template.category)}
                          className="rounded-md bg-zinc-700 py-1 text-[10px] hover:bg-zinc-600"
                        >
                          Apply
                        </button>

                        <button
                          onClick={() => onCreateProject(template.id)}
                          className="rounded-md bg-indigo-600 py-1 text-[10px] hover:bg-indigo-500"
                        >
                          + New
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}