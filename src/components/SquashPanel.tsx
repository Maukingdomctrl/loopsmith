"use client";

/**
 * Squash & stretch for the current frame: one slider (wider ⇄ taller, area
 * kept) and where the layer stays put. The amount is read from the layer's
 * pose, so it always matches what is on the canvas.
 */

import { useState } from "react";
import type { Layer } from "@/types/layer";
import type { LayerAction } from "@/lib/layers/editor";
import {
  amountToStretch,
  stretchOf,
  stretchToAmount,
  squashAnchorPoint,
  type SquashAnchor,
} from "@/lib/layers/squash";

interface Props {
  layer: Layer | null;
  disabled?: boolean;
  dispatch: (a: LayerAction) => void;
  /** The slider drag ended: the next change is a new undo step. */
  onEnd: () => void;
}

const ANCHORS: { id: SquashAnchor; label: string }[] = [
  { id: "bottom", label: "Bottom" },
  { id: "center", label: "Center" },
  { id: "top", label: "Top" },
];

export default function SquashPanel({ layer, disabled, dispatch, onEnd }: Props) {
  const [anchor, setAnchor] = useState<SquashAnchor>("bottom");
  const locked = !layer || layer.locked || !!disabled;
  const amount = layer ? stretchToAmount(stretchOf(layer.pose)) : 0;

  const set = (v: number) => {
    if (!layer || locked) return;
    dispatch({
      type: "xf/squash",
      id: layer.id,
      stretch: amountToStretch(v),
      anchor: squashAnchorPoint(layer, anchor),
    });
  };

  return (
    <div className="space-y-2 p-3 pt-0 text-xs">
      {layer && <div className="text-[10px] text-zinc-500">{layer.name}</div>}
      <label className="block text-[10px] text-zinc-400">
        <span className="flex justify-between">
          <span>Squash ◂ ▸ Stretch</span>
          <span className="text-zinc-300">
            {amount === 0 ? "0" : amount > 0 ? `${amount}% taller` : `${-amount}% wider`}
          </span>
        </span>
        <input
          type="range" min={-60} max={60} step={1}
          value={Math.max(-60, Math.min(60, amount))}
          disabled={locked}
          onChange={(e) => set(Number(e.target.value))}
          onPointerDown={onEnd}
          onPointerUp={onEnd}
          onKeyDown={onEnd}
          onKeyUp={onEnd}
          onDoubleClick={() => { onEnd(); set(0); onEnd(); }}
          className="mt-1 w-full accent-indigo-500 disabled:opacity-40"
        />
      </label>
      <div className="flex items-center gap-1 text-[10px] text-zinc-400">
        <span className="mr-1">Keep</span>
        {ANCHORS.map((a) => (
          <button
            key={a.id}
            onClick={() => setAnchor(a.id)}
            disabled={locked}
            title={`The ${a.id} of the layer stays in place`}
            className={`flex-1 rounded py-0.5 disabled:opacity-40 ${
              anchor === a.id ? "bg-indigo-500/30 text-white" : "bg-zinc-800 hover:bg-zinc-700"
            }`}
          >
            {a.label}
          </button>
        ))}
      </div>
      <button
        onClick={() => { onEnd(); set(0); onEnd(); }}
        disabled={locked || amount === 0}
        className="w-full rounded bg-zinc-800 py-1 text-[10px] text-zinc-300 hover:bg-zinc-700 disabled:opacity-40"
      >
        Reset squash
      </button>
    </div>
  );
}
