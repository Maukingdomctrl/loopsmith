"use client";

/**
 * Canvas background.
 *
 *  - `transparent` is DOCUMENT state: it decides whether the export has an
 *    alpha channel, so it changes the GIF's bytes.
 *  - `checkerboard` is VIEW state: only whether the editor draws a checker
 *    pattern behind the artwork. Never exported.
 */

import { Grid3x3 } from "lucide-react";
import type { CanvasBackground } from "@/types/layer";

interface Props {
  background: CanvasBackground;
  onChange: (next: CanvasBackground) => void;
  disabled?: boolean;
  /** Strip the solid background baked into the frames' artwork. */
  onRemoveArtBackground?: () => void;
  removingArtBackground?: boolean;
  artBackgroundNotice?: string | null;
}

const SWATCHES = [
  { name: "White", color: "#ffffff" },
  { name: "Pink", color: "#f3d9e8" },
  { name: "Sky", color: "#bfd9f5" },
  { name: "Mint", color: "#cdebdd" },
  { name: "Lemon", color: "#fbefb8" },
  { name: "Night", color: "#23233a" },
  { name: "Black", color: "#111111" },
];

const ring = (active: boolean) =>
  active ? "ring-2 ring-indigo-400 ring-offset-2 ring-offset-[#141821]" : "ring-1 ring-white/15";

export default function TransparencyToggle({
  background, onChange, disabled, onRemoveArtBackground, removingArtBackground, artBackgroundNotice,
}: Props) {
  const isPreset = SWATCHES.some(
    (s) => !background.transparent && s.color.toLowerCase() === background.color.toLowerCase()
  );

  return (
    <div className="space-y-3 border-t border-white/10 p-3 text-xs">
      <div className="text-[10px] font-medium tracking-wide text-zinc-400">BACKGROUND</div>

      <div className="flex flex-wrap gap-2">
        {/* Transparent */}
        <button
          disabled={disabled}
          onClick={() => onChange({ ...background, transparent: true })}
          title="Transparent"
          aria-label="Transparent background"
          className={`h-8 w-8 rounded-lg disabled:opacity-40 ${ring(background.transparent)}`}
          style={{
            backgroundColor: "#2a2a30",
            backgroundImage:
              "linear-gradient(45deg,#3a3a42 25%,transparent 25%,transparent 75%,#3a3a42 75%),linear-gradient(45deg,#3a3a42 25%,transparent 25%,transparent 75%,#3a3a42 75%)",
            backgroundSize: "10px 10px",
            backgroundPosition: "0 0,5px 5px",
          }}
        />

        {/* Presets */}
        {SWATCHES.map((s) => {
          const active = !background.transparent && s.color.toLowerCase() === background.color.toLowerCase();
          return (
            <button
              key={s.color}
              disabled={disabled}
              onClick={() => onChange({ ...background, transparent: false, color: s.color })}
              title={s.name}
              aria-label={`${s.name} background`}
              className={`h-8 w-8 rounded-lg disabled:opacity-40 ${ring(active)}`}
              style={{ background: s.color }}
            />
          );
        })}

        {/* Custom */}
        <label
          title="Custom colour"
          className={`relative flex h-8 w-8 cursor-pointer items-center justify-center overflow-hidden rounded-lg text-zinc-300 ${ring(
            !background.transparent && !isPreset
          )}`}
          style={!background.transparent && !isPreset ? { background: background.color } : undefined}
        >
          {(background.transparent || isPreset) && <span className="text-base leading-none">+</span>}
          <input
            type="color"
            value={background.color}
            disabled={disabled}
            onChange={(e) => onChange({ ...background, transparent: false, color: e.target.value })}
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label="Custom background colour"
          />
        </label>
      </div>

      {background.transparent && (
        <label className="flex items-center justify-between text-zinc-300">
          <span className="flex items-center gap-1.5">
            <Grid3x3 size={12} /> Show checkerboard
          </span>
          <input
            type="checkbox"
            checked={background.checkerboard}
            disabled={disabled}
            onChange={(e) => onChange({ ...background, checkerboard: e.target.checked })}
            className="accent-indigo-500"
          />
        </label>
      )}

      <p className="text-[10px] leading-snug text-zinc-500">
        {background.transparent
          ? "Exports with a transparent background. The checkerboard is only a preview."
          : "Exports on this colour. Edges blend smoothly: best quality for GIFs."}
      </p>

      {onRemoveArtBackground && (
        <>
          <button
            onClick={onRemoveArtBackground}
            disabled={disabled || removingArtBackground}
            title="Remove the solid colour baked into the frames (e.g. the sheet they were cut from), so it no longer moves with the artwork"
            className="w-full rounded bg-zinc-800 px-2 py-1.5 text-[11px] text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
          >
            {removingArtBackground ? "Removing…" : "Remove background from art"}
          </button>
          {artBackgroundNotice && (
            <p className="text-[10px] leading-snug text-zinc-400">{artBackgroundNotice}</p>
          )}
        </>
      )}
    </div>
  );
}