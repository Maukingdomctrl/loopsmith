"use client";

import { X, Download } from "lucide-react";

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

const sizeOptions: ExportSize[] = [512, 320, 256, 128];
const limitOptions: ExportLimit[] = [512, 256];

const presetOptions = [
  {
    id: "sticker" as const,
    title: "Discord Sticker",
    subtitle: "320×320 • ≤512 KB",
  },
  {
    id: "emoji" as const,
    title: "Discord Emoji",
    subtitle: "128×128 • ≤256 KB",
  },
  {
    id: "hd" as const,
    title: "HD GIF",
    subtitle: "512×512 • Unlimited",
  },
  {
    id: "custom" as const,
    title: "Custom",
    subtitle: "Choose size & limit",
  },
];

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

  return (
    <div className="absolute inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-[620px] rounded-2xl border border-white/10 bg-[#171B24] p-6 text-white shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-xl font-semibold">Export Animated GIF</h2>

          <button
            onClick={onClose}
            className="rounded-lg p-2 hover:bg-white/10"
          >
            <X size={18} />
          </button>
        </div>

        <p className="mb-5 text-sm text-zinc-400">
          Export with Discord-ready presets or choose your own settings.
        </p>

        {/* Presets */}
        <div className="mb-6">
          <p className="mb-3 text-sm font-medium text-zinc-300">
            Export preset
          </p>

          <div className="grid grid-cols-2 gap-3">
            {presetOptions.map((item) => (
              <button
                key={item.id}
                onClick={() => onPresetChange(item.id)}
                className={`rounded-xl border p-3 text-left transition ${
                  preset === item.id
                    ? "border-indigo-500 bg-indigo-500/15"
                    : "border-zinc-700 hover:border-zinc-500"
                }`}
              >
                <div className="font-semibold">{item.title}</div>
                <div className="mt-1 text-xs text-zinc-400">
                  {item.subtitle}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Discord Sticker */}
        {preset === "sticker" && (
          <div className="mb-6 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
            <p className="mb-3 text-sm font-medium text-emerald-300">
              Discord Sticker
            </p>

            <div className="flex items-center justify-between">
              <div>
                <div className="text-2xl font-bold">320 × 320</div>
                <div className="mt-1 text-sm text-zinc-300">
                  Transparent animated sticker
                </div>
                <div className="text-xs text-zinc-400">
                  Auto-optimized near 500 KB
                </div>
              </div>

              <div className="rounded-lg bg-emerald-600 px-3 py-1 text-sm font-semibold">
                Fixed
              </div>
            </div>
          </div>
        )}

        {/* Discord Emoji */}
        {preset === "emoji" && (
          <div className="mb-6 rounded-xl border border-sky-500/30 bg-sky-500/10 p-4">
            <p className="mb-3 text-sm font-medium text-sky-300">
              Discord Emoji
            </p>

            <div className="flex items-center justify-between">
              <div>
                <div className="text-2xl font-bold">128 × 128</div>
                <div className="mt-1 text-sm text-zinc-300">
                  Transparent animated emoji
                </div>
                <div className="text-xs text-zinc-400">
                  Auto-optimized near 250 KB
                </div>
              </div>

              <div className="rounded-lg bg-sky-600 px-3 py-1 text-sm font-semibold">
                Fixed
              </div>
            </div>
          </div>
        )}

        {/* HD */}
        {preset === "hd" && (
          <div className="mb-6 rounded-xl border border-violet-500/30 bg-violet-500/10 p-4">
            <p className="mb-3 text-sm font-medium text-violet-300">HD GIF</p>

            <div className="flex items-center justify-between">
              <div>
                <div className="text-2xl font-bold">512 × 512</div>
                <div className="mt-1 text-sm text-zinc-300">
                  Maximum quality export
                </div>
                <div className="text-xs text-zinc-400">
                  No file size limit
                </div>
              </div>

              <div className="rounded-lg bg-violet-600 px-3 py-1 text-sm font-semibold">
                Fixed
              </div>
            </div>
          </div>
        )}

        {/* Custom */}
        {preset === "custom" && (
          <div className="space-y-6 mb-6">
            <div>
              <p className="mb-3 text-sm font-medium text-zinc-300">
                Resolution
              </p>

              <div className="grid grid-cols-4 gap-3">
                {sizeOptions.map((value) => (
                  <button
                    key={value}
                    onClick={() => onSizeChange(value)}
                    className={`rounded-xl border p-3 transition ${
                      size === value
                        ? "border-indigo-500 bg-indigo-500/15"
                        : "border-zinc-700 hover:border-zinc-500"
                    }`}
                  >
                    <div className="mb-2 flex aspect-square items-center justify-center rounded-lg bg-zinc-800 text-lg font-bold">
                      {value}
                    </div>

                    <div className="text-xs font-medium">{value}px</div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-3 text-sm font-medium text-zinc-300">
                Maximum file size
              </p>

              <div className="grid grid-cols-2 gap-3">
                {limitOptions.map((kb) => (
                  <button
                    key={kb}
                    onClick={() => onLimitChange(kb)}
                    className={`rounded-xl border p-4 transition ${
                      limit === kb
                        ? "border-emerald-500 bg-emerald-500/15"
                        : "border-zinc-700 hover:border-zinc-500"
                    }`}
                  >
                    <div className="text-lg font-bold">≤ {kb} KB</div>
                    <div className="mt-1 text-xs text-zinc-400">
                      {kb === 512 ? "Target 480–510 KB" : "Target 220–251 KB"}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:bg-zinc-800"
          >
            Cancel
          </button>

          <button
            onClick={onExport}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium hover:bg-indigo-700"
          >
            <Download size={16} />
            Export GIF
          </button>
        </div>
      </div>
    </div>
  );
}