"use client";
import { useState } from "react";
import {
  Upload,
  Download,
  Play,
  Pause,
  Undo2,
  Redo2,
  Wand2,
  X,
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

const quiet =
  "flex h-10 items-center gap-2 rounded-ctrl px-3 text-sm text-icon hoverable hover:text-ink disabled:opacity-40";

export default function Toolbar({
  isPlaying,
  saveStatus,
  onPlay,
  onUndo,
  onRedo,
  onImport,
  onSlice,
  onExport,
  onAutoStabilize,
  onClearStabilization,
  stabilizeStatus,
  stabilizeProgress,
  hasStabilization,
  stabilizationStale,
}: ToolbarProps) {
  const isStabilizing =
    stabilizeStatus === "decoding" || stabilizeStatus === "running";
  const [importOpen, setImportOpen] = useState(false);

  const stabilizeLabel = isStabilizing
    ? stabilizeProgress
      ? `Stabilizing ${Math.round(stabilizeProgress.fraction * 100)}%`
      : "Stabilizing…"
    : stabilizationStale
      ? "Outdated · Re-run"
      : hasStabilization
        ? "Stabilized"
        : "Auto stabilize";

  return (
    <header className="shrink-0 flex h-16 items-center justify-between gap-4 border-b border-line bg-panel px-5">
      {/* Left: name + save state + file actions */}
      <div className="flex items-center gap-3">
        <h1 className="font-display text-[14px] font-semibold">Loop Emoji Studio</h1>
        <span className="inline-block w-14 text-[12px] text-ink-2">
          {saveStatus === "saving" ? "Saving…" : "Saved"}
        </span>

        <span className="mx-2 h-6 w-px bg-line" />

        <button onClick={onUndo} className={quiet} title="Undo (Ctrl+Z)" aria-label="Undo">
          <Undo2 size={18} />
        </button>
        <button onClick={onRedo} className={quiet} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
          <Redo2 size={18} />
        </button>

        <div className="relative" onMouseLeave={() => setImportOpen(false)}>
          <button onClick={() => setImportOpen((v) => !v)} className={quiet}>
            <Upload size={18} />
            Import
          </button>

          {importOpen && (
            <div className="absolute left-0 top-full z-50 w-56 pt-1">
              <div className="overflow-hidden rounded-panel border border-line bg-panel shadow-flyout">
                <button
                  onClick={() => { setImportOpen(false); onImport(); }}
                  className="block w-full px-4 py-3 text-left hover:bg-hover"
                >
                  <div className="text-sm font-medium">Single image</div>
                  <div className="text-xs text-ink-2">Into the current frame</div>
                </button>
                <button
                  onClick={() => { setImportOpen(false); onSlice(); }}
                  className="block w-full border-t border-line px-4 py-3 text-left hover:bg-hover"
                >
                  <div className="text-sm font-medium">Spritesheet</div>
                  <div className="text-xs text-ink-2">Cut into frames</div>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Centre: the main loop — stabilize, then watch */}
      <div className="flex items-center gap-2">
        <button
          onClick={onAutoStabilize}
          disabled={isPlaying || isStabilizing}
          title="Estimate the loop's global motion and remove only jitter"
          className={`flex h-10 min-w-[168px] items-center justify-center gap-2 rounded-ctrl px-4 text-sm font-semibold transition disabled:opacity-50 ${
            stabilizationStale
              ? "bg-warn-bg text-warn hoverable"
              : hasStabilization && !isStabilizing
                ? "bg-ctrl text-ink-2 hoverable"
                : "bg-ctrl text-ink hoverable"
          }`}
        >
          <Wand2 size={16} />
          {stabilizeLabel}
        </button>

                {hasStabilization && !isStabilizing && (
          <button
            onClick={onClearStabilization}
            disabled={isPlaying}
            title="Discard automatic stabilization"
            className={`flex h-10 items-center gap-1.5 rounded-ctrl px-3 text-sm font-medium disabled:opacity-40 ${
              stabilizationStale
                ? "bg-warn-bg text-warn hoverable"
                : "bg-ctrl text-ink hoverable"
            }`}
          >
            <X size={14} />
            {stabilizationStale ? "Stale — Discard" : "Discard"}
          </button>
        )}

        <button
          onClick={onPlay}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-ctrl text-ink hoverable"
          title={isPlaying ? "Pause (Enter)" : "Play (Enter)"}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
        </button>
      </div>

      {/* Right: finish */}
      <button
        onClick={onExport}
        className="flex h-10 items-center gap-2 rounded-ctrl border border-line-strong px-4 text-sm font-medium hover:bg-hover"
      >
        <Download size={18} />
        Export
      </button>
    </header>
  );
}