"use client";

import { Brush, Lasso, WandSparkles } from "lucide-react";

export type TransparencyTool = "brush" | "lasso" | "wand";

interface Props {
  enabled: boolean;
  tool: TransparencyTool;
  feather: number;
  tolerance: number;
  onEnabledChange: (v: boolean) => void;
  onToolChange: (tool: TransparencyTool) => void;
  onFeatherChange: (v: number) => void;
  onToleranceChange: (v: number) => void;
}

export default function TransparencyPanel({
  enabled,
  tool,
  feather,
  tolerance,
  onEnabledChange,
  onToolChange,
  onFeatherChange,
  onToleranceChange,
}: Props) {
  return (
    <div className="space-y-3 border-t border-white/10 p-3 text-xs">
      <div className="text-[10px] font-medium tracking-wide text-zinc-400">
        TRANSPARENCY
      </div>

      {/* Enable */}
      <label className="flex items-center justify-between text-zinc-300">
        <span>Enable Editing</span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onEnabledChange(e.target.checked)}
          className="accent-cyan-500"
        />
      </label>

      {enabled && (
        <>
          {/* Tools */}
          <div className="space-y-1">
            <div className="text-[10px] text-zinc-500">TOOL</div>

            <div className="grid grid-cols-3 gap-1">
              <button
                onClick={() => onToolChange("brush")}
                className={`flex items-center justify-center gap-1 rounded-lg border px-2 py-2 ${
                  tool === "brush"
                    ? "border-cyan-500 bg-cyan-500/20 text-white"
                    : "border-zinc-700 text-zinc-400"
                }`}
              >
                <Brush size={14} />
              </button>

              <button
                onClick={() => onToolChange("lasso")}
                className={`flex items-center justify-center gap-1 rounded-lg border px-2 py-2 ${
                  tool === "lasso"
                    ? "border-cyan-500 bg-cyan-500/20 text-white"
                    : "border-zinc-700 text-zinc-400"
                }`}
              >
                <Lasso size={14} />
              </button>

              <button
                onClick={() => onToolChange("wand")}
                className={`flex items-center justify-center gap-1 rounded-lg border px-2 py-2 ${
                  tool === "wand"
                    ? "border-cyan-500 bg-cyan-500/20 text-white"
                    : "border-zinc-700 text-zinc-400"
                }`}
              >
                <WandSparkles size={14} />
              </button>
            </div>
          </div>

          {/* Feather */}
          <div className="space-y-1">
            <div className="flex justify-between text-zinc-400">
              <span>Feather</span>
              <span>{feather}px</span>
            </div>
            <input
              type="range"
              min={0}
              max={5}
              step={1}
              value={feather}
              onChange={(e) => onFeatherChange(Number(e.target.value))}
              className="w-full"
            />
          </div>

          {/* Tolerance (Magic Wand only) */}
          {tool === "wand" && (
            <div className="space-y-1">
              <div className="flex justify-between text-zinc-400">
                <span>Tolerance</span>
                <span>{tolerance}</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={tolerance}
                onChange={(e) => onToleranceChange(Number(e.target.value))}
                className="w-full"
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}