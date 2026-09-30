"use client";

import React from "react";
import type { ReactNode } from "react";
import TransparencyPanel from "./TransparencyPanel";
import type { TransparencyState } from "@/hooks/useTransparency";

interface RightSidebarProps {
  activeFrame: number;
  fps: number;
  onFpsChange: (fps: number) => void;
  onionSkin: boolean;
  onToggleOnion: (value: boolean) => void;
  duration: number;
  onDurationChange: (value: number) => void;
  showGuides: boolean;
  onToggleGuides: (value: boolean) => void;
  guideMode: "face" | "fullbody";
  onGuideModeChange: (mode: "face" | "fullbody") => void;
  transparency: TransparencyState;
  onTransparencyChange: (patch: Partial<TransparencyState>) => void;
  children?: ReactNode;
}

function RightSidebar({
  activeFrame,
  fps,
  onFpsChange,
  onionSkin,
  onToggleOnion,
  duration,
  onDurationChange,
  showGuides,
  onToggleGuides,
  guideMode,
  onGuideModeChange,

  transparency,
  onTransparencyChange,

  children,
}: RightSidebarProps){


  return (
    <aside className="w-72 shrink-0 overflow-y-auto border-l border-white/10 bg-[#141821] p-5">
      <h2 className="mb-5 font-semibold">Properties</h2>

      <div className="space-y-5">
        

        {/* FPS */}
        <div>
          <div className="mb-2 flex justify-between text-sm text-zinc-400">
            <span>Playback FPS</span>
            <span className="font-semibold text-white">{fps}</span>
          </div>

          <input
            type="range"
            min={6}
            max={24}
            step={1}
            value={fps}
            onChange={(e) => onFpsChange(Number(e.target.value))}
            className="w-full accent-indigo-500"
          />

          <div className="mt-2 flex justify-between text-[11px] text-zinc-500">
            <span>6</span>
            <span>12</span>
            <span>18</span>
            <span>24</span>
          </div>
        </div>

        {/* Frame Duration */}
        <div>
          <div className="mb-2 flex justify-between text-sm text-zinc-400">
            <span>Frame Hold</span>
            <span className="font-semibold text-white">
              {duration} tick{duration > 1 ? "s" : ""}
            </span>
          </div>

          <input
            type="range"
            min={1}
            max={24}
            step={1}
            value={duration}
            onChange={(e) => onDurationChange(Number(e.target.value))}
            className="w-full accent-emerald-500"
          />

          <div className="mt-2 flex justify-between text-[11px] text-zinc-500">
            <span>1</span>
            <span>8</span>
            <span>16</span>
            <span>24</span>
          </div>
        </div>

        {/* Onion Skin */}
        <div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-400">Onion Skin</span>

            <button
              onClick={() => onToggleOnion(!onionSkin)}
              className={`relative h-7 w-12 rounded-full transition ${
                onionSkin ? "bg-indigo-600" : "bg-zinc-700"
              }`}
            >
              <div
                className={`absolute top-1 h-5 w-5 rounded-full bg-white transition ${
                  onionSkin ? "left-6" : "left-1"
                }`}
              />
            </button>
          </div>
        </div>

        {/* Emoji Guides */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-400">Emoji Guides</span>

            <button
              onClick={() => onToggleGuides(!showGuides)}
              className={`relative h-7 w-12 rounded-full transition ${
                showGuides ? "bg-cyan-600" : "bg-zinc-700"
              }`}
            >
              <div
                className={`absolute top-1 h-5 w-5 rounded-full bg-white transition ${
                  showGuides ? "left-6" : "left-1"
                }`}
              />
            </button>
          </div>

          {showGuides && (
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => onGuideModeChange("face")}
                className={`rounded-lg py-2 text-xs font-medium transition ${
                  guideMode === "face"
                    ? "bg-cyan-600 text-white"
                    : "bg-zinc-800 text-zinc-300"
                }`}
              >
                Face
              </button>

              <button
                onClick={() => onGuideModeChange("fullbody")}
                className={`rounded-lg py-2 text-xs font-medium transition ${
                  guideMode === "fullbody"
                    ? "bg-cyan-600 text-white"
                    : "bg-zinc-800 text-zinc-300"
                }`}
              >
                Full Body
              </button>
            </div>
          )}
        </div>

            
  </div>
        <details className="group mt-4 border-t border-white/10 pt-3">
      <summary className="cursor-pointer select-none list-none text-xs font-semibold tracking-wide text-zinc-400 hover:text-white">
        ▸ ERASER &amp; TRANSPARENCY
      </summary>
    <TransparencyPanel
    enabled={transparency.enabled}
    tool={transparency.tool}
    feather={transparency.feather}
    tolerance={transparency.tolerance}
    onEnabledChange={(v) => onTransparencyChange({ enabled: v })}
    onToolChange={(tool) => onTransparencyChange({ tool })}
    onFeatherChange={(feather) => onTransparencyChange({ feather })}
    onToleranceChange={(tolerance) =>
      onTransparencyChange({ tolerance })
    }
  />
    </details>
  {children}
</aside>
  );
}

export default React.memo(RightSidebar);