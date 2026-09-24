"use client";

/**
 * Canvas transparency.
 *
 * Two genuinely separate concerns, deliberately not merged into one switch:
 *
 *  - `transparent` is DOCUMENT state. It decides whether the export has an
 *    alpha channel, so it changes the GIF's bytes.
 *  - `checkerboard` is VIEW state. It only decides whether the editor draws a
 *    checker pattern behind the artwork, and is never exported.
 *
 * Collapsing them is the standard bug that ships checkerboards inside
 * customers' stickers.
 */

import { Grid3x3, Square } from "lucide-react";
import type { CanvasBackground } from "@/types/layer";

interface Props {
  background: CanvasBackground;
  onChange: (next: CanvasBackground) => void;
  disabled?: boolean;
}

export default function TransparencyToggle({ background, onChange, disabled }: Props) {
  return (
    <div className="space-y-2 border-t border-white/10 p-3 text-xs">
      <div className="text-[10px] font-medium tracking-wide text-zinc-400">CANVAS</div>

      <label className="flex items-center justify-between text-zinc-300">
        <span className="flex items-center gap-1.5"><Square size={12} /> Transparent</span>
        <input
          type="checkbox"
          checked={background.transparent}
          disabled={disabled}
          onChange={(e) => onChange({ ...background, transparent: e.target.checked })}
          className="accent-cyan-500"
        />
      </label>

      {!background.transparent && (
        <label className="flex items-center justify-between text-zinc-300">
          <span>Colour</span>
          <input
            type="color"
            value={background.color}
            disabled={disabled}
            onChange={(e) => onChange({ ...background, color: e.target.value })}
            className="h-6 w-10 rounded border border-zinc-600 bg-transparent"
          />
        </label>
      )}

      <label className="flex items-center justify-between text-zinc-300">
        <span className="flex items-center gap-1.5"><Grid3x3 size={12} /> Checkerboard</span>
        <input
          type="checkbox"
          checked={background.checkerboard}
          disabled={disabled || !background.transparent}
          onChange={(e) => onChange({ ...background, checkerboard: e.target.checked })}
          className="accent-cyan-500"
        />
      </label>
      <p className="text-[9px] leading-snug text-zinc-500">
        The checkerboard is a preview aid only and is never included in exports.
      </p>
    </div>
  );
}
