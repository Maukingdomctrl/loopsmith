"use client";

import { X, Download, Check } from "lucide-react";

export type ExportPreset = "sticker" | "emoji" | "hd" | "custom";
export type ExportSize = 512 | 320 | 256 | 128;
export type ExportLimit = 512 | 256 | "none";

interface Props {
  open: boolean;
  preset: ExportPreset;
  size: ExportSize;
  limit: ExportLimit;
  onPresetChange: (preset: ExportPreset) => void;
  onSizeChange: (size: ExportSize) => void;
  onLimitChange: (limit: ExportLimit) => void;
  onClose: () => void;
  onExport: () => void;
}

const PRESETS: { id: ExportPreset; title: string; note: string; size: string }[] = [
  { id: "sticker", title: "Discord sticker", note: "Max 512 KB", size: "320 × 320" },
  { id: "emoji", title: "Discord emoji", note: "Max 256 KB", size: "128 × 128" },
  { id: "hd", title: "HD GIF", note: "No size limit", size: "512 × 512" },
  { id: "custom", title: "Custom", note: "Pick size and limit", size: "— × —" },
];

const SIZES: ExportSize[] = [128, 256, 320, 512];
const LIMITS: ExportLimit[] = [256, 512, "none"];

const chip = (active: boolean) =>
  `h-9 rounded-lg px-3 text-sm transition ${
    active
      ? "bg-indigo-500/20 text-white ring-1 ring-indigo-400"
      : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
  }`;

export default function ExportDialog({
  open,
  preset,
  size,
  limit,
  onPresetChange,
  onSizeChange,
  onLimitChange,
  onClose,
  onExport,
}: Props) {
  if (!open) return null;

  const current = PRESETS.find((p) => p.id === preset) ?? PRESETS[0];
  const shownSize = preset === "custom" ? `${size} × ${size}` : current.size;
  const shownLimit =
    preset === "custom"
      ? limit === "none" ? "No size limit" : `Max ${limit} KB`
      : current.note;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[640px] overflow-hidden rounded-2xl border border-white/10 bg-[#171B24] text-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
          <h2 className="text-lg font-semibold">Export GIF</h2>
          <button onClick={onClose} className="rounded-lg p-2 hover:bg-white/10" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="grid grid-cols-[1fr_220px]">
          {/* Presets */}
          <div className="space-y-2 p-5">
            {PRESETS.map((p) => {
              const active = preset === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => onPresetChange(p.id)}
                  className={`flex w-full items-center justify-between rounded-xl px-4 py-3 text-left transition ${
                    active
                      ? "bg-indigo-500/15 ring-1 ring-indigo-400"
                      : "bg-zinc-800/60 hover:bg-zinc-800"
                  }`}
                >
                  <span>
                    <span className="block text-sm font-medium">{p.title}</span>
                    <span className="block text-xs text-zinc-400">{p.note}</span>
                  </span>
                  <span className="flex items-center gap-2 font-mono text-xs text-zinc-400">
                    {p.size}
                    {active && <Check size={14} className="text-indigo-300" />}
                  </span>
                </button>
              );
            })}

            {preset === "custom" && (
              <div className="space-y-3 rounded-xl bg-zinc-900/60 p-4">
                <div>
                  <p className="mb-2 text-xs text-zinc-400">Size (px)</p>
                  <div className="flex flex-wrap gap-2">
                    {SIZES.map((s) => (
                      <button key={s} onClick={() => onSizeChange(s)} className={chip(size === s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="mb-2 text-xs text-zinc-400">Max file size</p>
                  <div className="flex flex-wrap gap-2">
                    {LIMITS.map((l) => (
                      <button key={String(l)} onClick={() => onLimitChange(l)} className={chip(limit === l)}>
                        {l === "none" ? "No limit" : `${l} KB`}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Summary */}
          <div className="flex flex-col justify-between border-l border-white/10 bg-black/20 p-5">
            <div className="space-y-4">
              <div>
                <p className="text-xs text-zinc-500">Output</p>
                <p className="mt-1 font-mono text-2xl font-semibold">{shownSize}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-500">File size</p>
                <p className="mt-1 text-sm">{shownLimit}</p>
              </div>
              <p className="text-xs leading-relaxed text-zinc-500">
                Uses your current background and all frames. Size-limited exports are
                optimised automatically to fit.
              </p>
            </div>

            <button
              onClick={onExport}
              className="mt-6 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 text-sm font-semibold hover:bg-indigo-500"
            >
              <Download size={16} />
              Export GIF
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}