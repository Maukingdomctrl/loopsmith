"use client";

import {
  Upload,
  Trash2,
  Copy,
  Download,
  Play,
  Pause,
  Undo2,
  Redo2,
  Wand2,
} from "lucide-react";

interface ToolbarProps {
  isPlaying: boolean;
  saveStatus: "saved" | "saving";

  onPlay: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onImport: () => void;
  onSlice: () => void;
  onExport: () => void;
  onClear: () => void;
  onDuplicate: () => void;
  onDeleteFrame: () => void;

  onAutoStabilize: () => void;
  onClearStabilization: () => void;

  stabilizeStatus: "idle" | "decoding" | "running" | "done" | "error";
  stabilizeProgress: {
    stage: string;
    fraction: number;
  } | null;

  hasStabilization: boolean;
  stabilizationStale?: boolean;
}

export default function Toolbar({
  isPlaying,
  saveStatus,
  onPlay,
  onUndo,
  onRedo,
  onImport,
  onSlice,
  onExport,
  onClear,
  onDuplicate,
  onDeleteFrame,
  onAutoStabilize,
  onClearStabilization,
  stabilizeStatus,
  stabilizeProgress,
  hasStabilization,
  stabilizationStale,
}: ToolbarProps) {
  const isStabilizing =
    stabilizeStatus === "decoding" || stabilizeStatus === "running";

  return (
    <header className="flex h-16 items-center justify-between border-b border-white/10 px-6">
      <div className="flex items-center gap-4">
        <h1 className="text-xl font-bold">Loop Emoji Studio</h1>

        <div className="rounded-full bg-zinc-800 px-3 py-1 text-xs">
          {saveStatus === "saving" ? "Saving..." : "Saved"}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={onUndo}
          className="rounded-lg bg-zinc-800 p-2 hover:bg-zinc-700"
          title="Undo (Ctrl+Z)"
        >
          <Undo2 size={18} />
        </button>

        <button
          onClick={onRedo}
          className="rounded-lg bg-zinc-800 p-2 hover:bg-zinc-700"
          title="Redo (Ctrl+Shift+Z)"
        >
          <Redo2 size={18} />
        </button>

        <button
          onClick={onImport}
          className="flex items-center gap-2 rounded-lg bg-zinc-800 px-4 py-2 hover:bg-zinc-700"
        >
          <Upload size={18} />
          Import
        </button>
        <button
          onClick={onSlice}
          className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 hover:bg-violet-500"
        >
          <Upload size={18} />
          Slice
        </button>

        

        <button
          onClick={onClear}
          className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 hover:bg-red-500"
        >
          <Trash2 size={18} />
          Clear
        </button>

        <button
          onClick={onDuplicate}
          className="flex items-center gap-2 rounded-lg bg-zinc-700 px-4 py-2 hover:bg-zinc-600"
        >
          <Copy size={18} />
          Duplicate
        </button>

        <button
          onClick={onDeleteFrame}
          className="flex items-center gap-2 rounded-lg bg-orange-600 px-4 py-2 hover:bg-orange-500"
        >
          <Trash2 size={18} />
          Delete Frame
        </button>

        <button
          onClick={onPlay}
          className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 hover:bg-emerald-500"
        >
          {isPlaying ? <Pause size={18} /> : <Play size={18} />}
          {isPlaying ? "Pause" : "Play"}
        </button>

        {/* Auto Stabilize */}
        <div className="ml-2 flex items-center gap-1 border-l border-zinc-700 pl-2">
          <button
            onClick={onAutoStabilize}
            disabled={isPlaying || isStabilizing}
            title="Estimate the loop's global motion and remove only jitter"
            className="flex h-10 items-center gap-2 rounded-lg bg-cyan-600 px-3 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-40"
          >
            <Wand2 size={16} />
            {isStabilizing && stabilizeProgress
              ? `${Math.round(stabilizeProgress.fraction * 100)}%`
              : "Stabilize"}
          </button>

          {hasStabilization && (
            <button
              onClick={onClearStabilization}
              disabled={isPlaying}
              title="Discard automatic stabilization only"
              className={`h-10 rounded-lg px-3 text-sm ${
                stabilizationStale
                  ? "bg-amber-600 text-white hover:bg-amber-500"
                  : "bg-zinc-700 text-zinc-200 hover:bg-zinc-600"
              }`}
            >
              {stabilizationStale ? "Stale — Discard" : "Discard"}
            </button>
          )}
        </div>

        <button
          onClick={onExport}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 hover:bg-indigo-500"
        >
          <Download size={18} />
          Export
        </button>
      </div>
    </header>
  );
}