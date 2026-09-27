"use client";

import { Plus, Copy, Eraser, Trash2 } from "lucide-react";

interface TimelineProps {
  frames: (string | null)[];
  activeFrame: number;
  onFrameSelect: (frame: number) => void;
  onReorder: (from: number, to: number) => void;
  onAddFrame: () => void;
  onImportFrame: (frame: number) => void;
  onDuplicate: () => void;
  onClear: () => void;
  onDeleteFrame: () => void;
}

export default function Timeline({
  frames,
  activeFrame,
  onFrameSelect,
  onReorder,
  onAddFrame,
  onImportFrame,
  onDuplicate,
  onClear,
  onDeleteFrame,
}: TimelineProps) {
  const actionClass =
    "flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white";

  return (
    <footer className="shrink-0 h-28 border-t border-white/10 bg-[#10131A] px-5 py-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm text-zinc-400">
          Timeline ({frames.length} frames) · Frame {activeFrame + 1}
        </p>

        <div className="flex items-center gap-1">
          <button onClick={onDuplicate} className={actionClass} title="Duplicate this frame">
            <Copy size={14} /> Duplicate
          </button>
          <button onClick={onClear} className={actionClass} title="Clear this frame's pixels">
            <Eraser size={14} /> Clear
          </button>
          <button
            onClick={onDeleteFrame}
            className={`${actionClass} hover:bg-red-900/40 hover:text-red-300`}
            title="Delete this frame"
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      </div>

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
              if (raw.trim() === "" || Number.isNaN(from) || from === i) return;
              onReorder(from, i);
            }}
            className={`relative h-[60px] w-[60px] flex-shrink-0 overflow-hidden rounded-xl border transition ${
              activeFrame === i
                ? "border-indigo-500 bg-indigo-500/20"
                : "border-zinc-700 bg-zinc-800 hover:bg-zinc-700"
            }`}
          >
            {image ? (
              <img src={image} alt={`Frame ${i + 1}`} className="h-full w-full object-contain" />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-sm text-zinc-500">
                {i + 1}
              </div>
            )}
          </button>
        ))}

        <button
          onClick={onAddFrame}
          className="flex h-[60px] w-[60px] flex-shrink-0 items-center justify-center rounded-xl border-2 border-dashed border-zinc-600 text-zinc-400 transition hover:border-indigo-500 hover:text-indigo-400"
        >
          <Plus size={24} />
        </button>
      </div>
    </footer>
  );
}