"use client";

import React from "react";
import type { ReactNode } from "react";
import { ChevronsRight } from "lucide-react";
import TransparencyPanel from "./TransparencyPanel";
import Accordion from "./Accordion";
import { rangeFill } from "@/styles/tokens";
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
  /** Collapse the panel to its rail. */
  onCollapse?: () => void;
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
  onCollapse,
}: RightSidebarProps){


  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex h-[52px] shrink-0 items-center border-b border-line pl-5 pr-2">
        <h2 className="section-title flex-1">Properties</h2>
        {onCollapse && (
          <button
            onClick={onCollapse}
            title="Collapse properties"
            aria-label="Collapse properties panel"
            className="flex h-8 w-8 items-center justify-center rounded-ctrl text-icon hoverable"
          >
            <ChevronsRight size={17} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
      <div className="space-y-6">
        <div className="section-title">Playback</div>

        {/* FPS */}
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[14px] font-medium text-ink-2">Speed</span>
            <span className="font-mono text-[15px] font-medium text-ink">{fps} fps</span>
          </div>

          <input
            type="range"
            min={6}
            max={24}
            step={1}
            value={fps}
            onChange={(e) => onFpsChange(Number(e.target.value))}
            aria-label="Playback speed (frames per second)"
            className="w-full"
            style={rangeFill(fps, 6, 24)}
          />

          <div className="mt-1 flex justify-between font-mono text-[11px] text-ink-3">
            <span>6</span>
            <span>12</span>
            <span>18</span>
            <span>24</span>
          </div>
        </div>

        {/* Frame Duration */}
        <div>
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[14px] font-medium text-ink-2">Frame hold</span>
            <span className="font-mono text-[15px] font-medium text-ink">
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
            aria-label="Frame hold (ticks)"
            className="w-full"
            style={rangeFill(duration, 1, 24)}
          />

          <div className="mt-1 flex justify-between font-mono text-[11px] text-ink-3">
            <span>1</span>
            <span>8</span>
            <span>16</span>
            <span>24</span>
          </div>
        </div>

        {/* Onion Skin */}
        <div>
          <div className="flex items-center justify-between">
            <span className="text-[14px] font-medium text-ink-2">Onion skin</span>

            <button
              onClick={() => onToggleOnion(!onionSkin)}
              role="switch"
              aria-checked={onionSkin}
              aria-label="Onion skin"
              className={`relative h-7 w-12 rounded-full transition ${
                onionSkin ? "bg-primary" : "bg-ctrl-hi"
              }`}
            >
              <div
                className={`absolute top-1 h-5 w-5 rounded-full bg-ink transition ${
                  onionSkin ? "left-6" : "left-1"
                }`}
              />
            </button>
          </div>
        </div>

        {/* Emoji Guides */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[14px] font-medium text-ink-2">Emoji guides</span>

            <button
              onClick={() => onToggleGuides(!showGuides)}
              role="switch"
              aria-checked={showGuides}
              aria-label="Emoji guides"
              className={`relative h-7 w-12 rounded-full transition ${
                showGuides ? "bg-primary" : "bg-ctrl-hi"
              }`}
            >
              <div
                className={`absolute top-1 h-5 w-5 rounded-full bg-ink transition ${
                  showGuides ? "left-6" : "left-1"
                }`}
              />
            </button>
          </div>

          {showGuides && (
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => onGuideModeChange("face")}
                className={`rounded-ctrl py-2 text-xs font-medium hoverable ${
                  guideMode === "face"
                    ? "selected text-icon-on"
                    : "bg-ctrl text-ink"
                }`}
              >
                Face
              </button>

              <button
                onClick={() => onGuideModeChange("fullbody")}
                className={`rounded-ctrl py-2 text-xs font-medium hoverable ${
                  guideMode === "fullbody"
                    ? "selected text-icon-on"
                    : "bg-ctrl text-ink"
                }`}
              >
                Full body
              </button>
            </div>
          )}
        </div>

            
  </div>
        <div className="mt-4">
          <Accordion title="Eraser and transparency">
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
          </Accordion>
          {children}
        </div>
      </div>
    </aside>
  );
}

export default React.memo(RightSidebar);