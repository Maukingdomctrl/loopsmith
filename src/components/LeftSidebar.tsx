"use client";

import React from "react";

import { Image, Pencil, Eraser, Play } from "lucide-react";

function LeftSidebar() {
  const tools = [
    { icon: Image, active: true },
    { icon: Pencil, active: false },
    { icon: Eraser, active: false },
    { icon: Play, active: false },
  ];

  return (
    <aside className="flex w-20 flex-col items-center gap-4 border-r border-white/10 bg-[#141821] py-4">
      {tools.map((tool, i) => {
        const Icon = tool.icon;

        return (
          <button
            key={i}
            className={`flex h-12 w-12 items-center justify-center rounded-xl transition ${
              tool.active
                ? "bg-indigo-600 text-white"
                : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
            }`}
          >
            <Icon size={22} />
          </button>
        );
      })}
    </aside>
  );
}

export default React.memo(LeftSidebar);