"use client";
import { useState } from "react";
import {
  Upload,
  Download,
  Play,
  Pause,
  Undo2,
  Redo2,
  Sparkles,
  Repeat,
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
  "flex h-10 items-center gap-2 rounded-ctrl px-3 text-[14px] font-medium text-ink-2 hoverable hover:text-ink disabled:opacity-40";
const ghostIcon =
  "flex h-10 w-10 items-center justify-center rounded-ctrl text-icon hoverable hover:text-ink disabled:opacity-40";

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
    <header className="grid h-[60px] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 border-b border-line bg-panel px-5">
      {/* Left: identity, quiet save state, history and import */}
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-ctrl bg-accent-tint text-icon-accent">
          <Repeat size={15} strokeWidth={2.2} />
        </span>
        <h1 className="ml-1 whitespace-nowrap font-display text-[14px] font-semibold text-ink">
          Loop Emoji Studio
        </h1>
        <span
          className="ml-1 inline-flex w-16 items-center gap-1.5 text-[12px] text-ink-2"
          aria-live="polite"
        >
          <span
            className={`h-2 w-2 rounded-full ${saveStatus === "saving" ? "bg-ink-dim" : "bg-success"}`}
          />
          {saveStatus === "saving" ? "Saving…" : "Saved"}
        </span>

        <span className="mx-2 h-6 w-px bg-line" />

        <button onClick={onUndo} className={ghostIcon} title="Undo (Ctrl+Z)" aria-label="Undo">
          <Undo2 size={18} />
        </button>
        <button onClick={onRedo} className={ghostIcon} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
          <Redo2 size={18} />
        </button>

        <div
          className="relative ml-1"
          onMouseLeave={() => setImportOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setImportOpen(false);
          }}
        >
          <button
            onClick={() => setImportOpen((v) => !v)}
            className={quiet}
            aria-haspopup="menu"
            aria-expanded={importOpen}
          >
            <Upload size={17} />
            Import
          </button>

          {importOpen && (
            <div className="absolute left-0 top-full z-50 w-56 pt-1" role="menu">
              <div className="overflow-hidden rounded-panel border border-line-strong bg-ctrl p-1 shadow-flyout">
                <button
                  role="menuitem"
                  onClick={() => { setImportOpen(false); onImport(); }}
                  className="block w-full rounded-ctrl px-3 py-2.5 text-left hoverable"
                >
                  <div className="text-[14px] font-medium text-ink">Single image</div>
                  <div className="text-[12px] text-ink-2">Into the current frame</div>
                </button>
                <button
                  role="menuitem"
                  onClick={() => { setImportOpen(false); onSlice(); }}
                  className="block w-full rounded-ctrl px-3 py-2.5 text-left hoverable"
                >
                  <div className="text-[14px] font-medium text-ink">Spritesheet</div>
                  <div className="text-[12px] text-ink-2">Cut into frames</div>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Centre: the main loop — watch, then stabilize */}
      <div className="flex items-center gap-2">
        <button
          onClick={onPlay}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-ctrl text-ink hoverable"
          title={isPlaying ? "Pause (Enter)" : "Play (Enter)"}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
        </button>

        <button
          onClick={onAutoStabilize}
          disabled={isPlaying || isStabilizing}
          title="Estimate the loop's global motion and remove only jitter"
          className={`flex h-10 min-w-[148px] items-center justify-center gap-2 rounded-ctrl px-4 text-[14px] font-medium hoverable disabled:opacity-50 ${
            stabilizationStale
              ? "bg-warn-bg text-warn"
              : hasStabilization && !isStabilizing
                ? "bg-ctrl text-ink-2"
                : "bg-ctrl text-ink"
          }`}
        >
          <Sparkles size={16} className={stabilizationStale ? "" : "text-icon-accent"} />
          <span className={isStabilizing ? "font-mono" : ""}>{stabilizeLabel}</span>
        </button>

        {hasStabilization && !isStabilizing && (
          <button
            onClick={onClearStabilization}
            disabled={isPlaying}
            title="Discard automatic stabilization"
            className={`flex h-10 items-center gap-1.5 rounded-ctrl px-3 text-[13px] font-medium hoverable disabled:opacity-40 ${
              stabilizationStale ? "bg-warn-bg text-warn" : "text-ink-2 hover:text-ink"
            }`}
          >
            <X size={14} />
            {stabilizationStale ? "Stale — Discard" : "Discard"}
          </button>
        )}
      </div>

      {/* Right: finish — the only filled purple in the app */}
      <div className="flex justify-end">
        <button
          onClick={onExport}
          className="flex h-10 items-center gap-2 rounded-ctrl bg-primary px-5 text-[14px] font-bold text-ink shadow-primary hoverable"
        >
          <Download size={17} />
          Export
        </button>
      </div>
    </header>
  );
}
