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
import { rangeFill } from "@/styles/tokens";

interface Props {
  layer: Layer | null;
  disabled?: boolean;
  dispatch: (a: LayerAction) => void;
  /** The slider drag ended: the next change is a new undo step. */
  onEnd: () => void;
  frameCount?: number;
  /** Apply a bounce cycle across all frames, this frame landing. */
  onBounce?: (layer: Layer | null, strength: number, anchor: SquashAnchor, hop: number) => void;
}

const ANCHORS: { id: SquashAnchor; label: string }[] = [
  { id: "bottom", label: "Bottom" },
  { id: "center", label: "Center" },
  { id: "top", label: "Top" },
];

export default function SquashPanel({
  layer, disabled, dispatch, onEnd, frameCount = 1, onBounce,
}: Props) {
  const [anchor, setAnchor] = useState<SquashAnchor>("bottom");
  const [bounce, setBounce] = useState(25);
  const [hop, setHop] = useState(30);
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
    <div className="space-y-3 pb-4 text-xs">
      {layer && <div className="text-[11px] text-ink-3">{layer.name}</div>}
      <label className="block text-[11px] text-ink-2">
        <span className="flex justify-between">
          <span>Squash ◂ ▸ Stretch</span>
          <span className="text-ink">
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
          className="mt-1 w-full  disabled:opacity-40"
        style={rangeFill(Math.max(-60, Math.min(60, amount)), -60, 60)}
      />
      </label>
      <div className="flex items-center gap-1 text-[11px] text-ink-2">
        <span className="mr-1">Keep</span>
        {ANCHORS.map((a) => (
          <button
            key={a.id}
            onClick={() => setAnchor(a.id)}
            disabled={locked}
            title={`The ${a.id} of the layer stays in place`}
            className={`flex-1 rounded-ctrl py-0.5 disabled:opacity-40 ${
              anchor === a.id ? "selected text-ink" : "bg-ctrl hoverable"
            }`}
          >
            {a.label}
          </button>
        ))}
      </div>
      <button
        onClick={() => { onEnd(); set(0); onEnd(); }}
        disabled={locked || amount === 0}
        className="w-full rounded-ctrl bg-ctrl py-1 text-[11px] text-ink hoverable disabled:opacity-40"
      >
        Reset squash
      </button>

      {onBounce && (
        <div className="space-y-1 border-t border-line pt-2">
          <label className="block text-[11px] text-ink-2">
            <span className="flex justify-between">
              <span>Bounce strength</span>
              <span className="text-ink">{bounce}%</span>
            </span>
            <input
              type="range" min={5} max={60} step={1}
              value={bounce}
              disabled={locked}
              onChange={(e) => setBounce(Number(e.target.value))}
              className="mt-1 w-full  disabled:opacity-40"
        style={rangeFill(bounce, 5, 60)}
      />
          </label>
          <label className="block text-[11px] text-ink-2">
            <span className="flex justify-between">
              <span>Hop height</span>
              <span className="text-ink">{hop === 0 ? "none" : `${hop} px`}</span>
            </span>
            <input
              type="range" min={0} max={150} step={1}
              value={hop}
              disabled={locked}
              onChange={(e) => setHop(Number(e.target.value))}
              className="mt-1 w-full  disabled:opacity-40"
        style={rangeFill(hop, 0, 150)}
      />
          </label>
          <button
            onClick={() => onBounce(layer, bounce, anchor, hop)}
            disabled={locked || frameCount < 2}
            title="This frame lands (squashed, on the ground); the others follow a bounce: stretched going up, highest and as drawn at the top, stretched coming down. Bouncing again replaces the previous hop."
            className="w-full rounded-ctrl bg-ctrl py-1 text-[11px] text-ink hoverable disabled:opacity-40"
          >
            Bounce across all frames
          </button>
        </div>
      )}
    </div>
  );
}
