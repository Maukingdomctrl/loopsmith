"use client";

import { Plus } from "lucide-react";

interface TimelineProps {
  frames: (string | null)[];
  activeFrame: number;
  onFrameSelect: (frame: number) => void;
  onReorder: (from: number, to: number) => void;
  onAddFrame: () => void;
  onImportFrame: (frame: number) => void;
}

export default function Timeline({
  frames,
  activeFrame,
  onFrameSelect,
  onReorder,
  onAddFrame,
  onImportFrame,
}: TimelineProps) {
  return (
    <footer className="h-28 border-t border-white/10 bg-[#10131A] px-5 py-3">
      <p className="mb-3 text-sm text-zinc-400">
        Timeline ({frames.length} frames)
      </p>

      <div className="flex items-center gap-3 overflow-x-auto pb-2">
        {frames.map((image, i) => (
          <button
            key={i}
            draggable
            onClick={() => onFrameSelect(i)}
            onDoubleClick={() => {
              if (!image) onImportFrame(i);
            }}
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", String(i));
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
              e.preventDefault();

              const raw = e.dataTransfer.getData("text/plain");
              const from = Number(raw);

              if (raw.trim() === "" || Number.isNaN(from) || from === i) {
                return;
              }

              onReorder(from, i);
            }}
            className={`relative h-[72px] w-[72px] flex-shrink-0 overflow-hidden rounded-xl border transition ${
              activeFrame === i
                ? "border-indigo-500 bg-indigo-500/20"
                : "border-zinc-700 bg-zinc-800 hover:bg-zinc-700"
            }`}
          >
            {image ? (
              <img
                src={image}
                alt={`Frame ${i + 1}`}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-sm text-zinc-500">
                {i + 1}
              </div>
            )}
          </button>
        ))}

        <button
          onClick={onAddFrame}
          className="flex h-[72px] w-[72px] flex-shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-zinc-600 text-zinc-400 transition hover:border-indigo-500 hover:text-indigo-400"
        >
          <Plus size={28} />
        </button>
      </div>
    </footer>
  );
}