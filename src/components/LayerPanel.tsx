"use client";

/**
 * The layer stack, rendered TOP-FIRST.
 *
 * The array is bottom-to-top because that is composite order; the panel
 * reverses it because that is how every layer UI in existence reads. Doing the
 * reversal here, once, is why `moveLayer` can keep taking array indices and
 * never has to know about display order.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, Lock, Unlock, Plus, Copy, Trash2, ChevronUp, ChevronDown, Layers as LayersIcon } from "lucide-react";

import type { BlendMode, Layer, LayerSelection } from "@/types/layer";
import { BLEND_MODES } from "@/types/layer";
import type { LayerAction } from "@/lib/layers/editor";
import { MAX_LAYERS_PER_FRAME } from "@/lib/layers/constants";

interface Props {
  layers: readonly Layer[];
  selection: LayerSelection;
  disabled?: boolean;
  onSelect: (id: string, mode?: "replace" | "toggle" | "add" | "range") => void;
  dispatch: (a: LayerAction) => void;
  onAddImage: () => void;
}

export default function LayerPanel({
  layers, selection, disabled, onSelect, dispatch, onAddImage,
}: Props) {
  // Reverse for display only. The index handed back to `moveLayer` is always
  // recomputed against the real array.
  const rows = useMemo(() => [...layers].reverse(), [layers]);
  const dragFrom = useRef<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const handleDrop = useCallback(
    (targetId: string) => {
      const from = dragFrom.current;
      dragFrom.current = null;
      if (!from || from === targetId) return;
      // Display row k maps to array index (len - 1 - k); the drop slot is
      // "above the target", i.e. target index + 1 in array terms.
      const targetIdx = layers.findIndex((l) => l.id === targetId);
      if (targetIdx < 0) return;
      dispatch({ type: "layer/move", id: from, to: targetIdx + 1 });
    },
    [dispatch, layers]
  );

  const commitRename = useCallback(
    (id: string) => {
      if (draft.trim()) dispatch({ type: "layer/rename", id, name: draft });
      setRenamingId(null);
      setDraft("");
    },
    [dispatch, draft]
  );

  const primary = selection.primary;
  const primaryLayer = layers.find((l) => l.id === primary) ?? null;

  return (
    <aside className="flex w-60 flex-col border-l border-white/10 bg-[#10131A]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-medium text-zinc-300">
          <LayersIcon size={14} />
          Layers
          <span className="text-zinc-500">
            {layers.length}/{MAX_LAYERS_PER_FRAME}
          </span>
        </div>
        <button
          onClick={onAddImage}
          disabled={disabled || layers.length >= MAX_LAYERS_PER_FRAME}
          title="Add layer from image"
          className="rounded p-1 text-zinc-300 hover:bg-zinc-700 disabled:opacity-30"
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {rows.map((layer) => {
          const isSelected = selection.ids.includes(layer.id);
          const isBase = layer.kind === "base";

          return (
            <div
              key={layer.id}
              draggable={!isBase && !disabled}
              onDragStart={() => { dragFrom.current = layer.id; }}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }}
              onDrop={(e) => { e.preventDefault(); handleDrop(layer.id); }}
              onClick={(e) =>
                onSelect(
                  layer.id,
                  e.shiftKey ? "range" : e.metaKey || e.ctrlKey ? "toggle" : "replace"
                )
              }
              className={`flex cursor-pointer items-center gap-2 border-b border-white/5 px-2 py-1.5 text-xs ${
                isSelected ? "bg-indigo-500/20" : "hover:bg-zinc-800/60"
              } ${primary === layer.id ? "ring-1 ring-inset ring-indigo-400" : ""}`}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: "layer/visible", id: layer.id, value: !layer.visible });
                }}
                disabled={disabled}
                title={layer.visible ? "Hide" : "Show"}
                className="text-zinc-400 hover:text-white disabled:opacity-30"
              >
                {layer.visible ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>

              <div className="h-8 w-8 flex-shrink-0 overflow-hidden rounded border border-zinc-700 bg-[#1b1f28]">
                {layer.image && (
                  <img src={layer.image} alt="" className="h-full w-full object-contain" />
                )}
              </div>

              <div className="min-w-0 flex-1">
                {renamingId === layer.id ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitRename(layer.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") { setRenamingId(null); setDraft(""); }
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-full rounded bg-zinc-900 px-1 text-xs text-white outline-none"
                  />
                ) : (
                  <div
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setRenamingId(layer.id);
                      setDraft(layer.name);
                    }}
                    className="truncate text-zinc-200"
                    title={layer.name}
                  >
                    {layer.name}
                    {isBase && <span className="ml-1 text-[9px] text-cyan-400">BASE</span>}
                  </div>
                )}
                <div className="text-[9px] text-zinc-500">
                  {Math.round(layer.opacity * 100)}%
                  {layer.blend !== "normal" && ` · ${layer.blend}`}
                  {layer.crop && " · cropped"}
                </div>
              </div>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  dispatch({ type: "layer/locked", id: layer.id, value: !layer.locked });
                }}
                disabled={disabled}
                title={layer.locked ? "Unlock" : "Lock"}
                className={`${layer.locked ? "text-amber-400" : "text-zinc-500"} hover:text-white disabled:opacity-30`}
              >
                {layer.locked ? <Lock size={13} /> : <Unlock size={13} />}
              </button>
            </div>
          );
        })}
      </div>

      {/* Per-layer properties for the primary selection. */}
      {primaryLayer && (
        <div className="space-y-2 border-t border-white/10 p-3">
          <label className="block text-[10px] text-zinc-400">
            Opacity — {Math.round(primaryLayer.opacity * 100)}%
            <input
              type="range" min={0} max={100} step={1}
              value={Math.round(primaryLayer.opacity * 100)}
              disabled={disabled || primaryLayer.locked}
              onChange={(e) =>
                dispatch({
                  type: "layer/opacity",
                  id: primaryLayer.id,
                  value: Number(e.target.value) / 100,
                })
              }
              className="mt-1 w-full accent-indigo-500 disabled:opacity-40"
            />
          </label>

          <label className="block text-[10px] text-zinc-400">
            Blend
            <select
              value={primaryLayer.blend}
              disabled={disabled || primaryLayer.locked}
              onChange={(e) =>
                dispatch({
                  type: "layer/blend",
                  id: primaryLayer.id,
                  value: e.target.value as BlendMode,
                })
              }
              className="mt-1 w-full rounded bg-zinc-800 px-1 py-1 text-xs text-white outline-none disabled:opacity-40"
            >
              {BLEND_MODES.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>

          <div className="flex gap-1">
            <button
              onClick={() => dispatch({ type: "layer/raise", id: primaryLayer.id })}
              disabled={disabled || primaryLayer.kind === "base"}
              className="flex-1 rounded bg-zinc-700 p-1 hover:bg-zinc-600 disabled:opacity-30"
              title="Raise"
            ><ChevronUp size={13} className="mx-auto" /></button>
            <button
              onClick={() => dispatch({ type: "layer/lower", id: primaryLayer.id })}
              disabled={disabled || primaryLayer.kind === "base"}
              className="flex-1 rounded bg-zinc-700 p-1 hover:bg-zinc-600 disabled:opacity-30"
              title="Lower"
            ><ChevronDown size={13} className="mx-auto" /></button>
            <button
              onClick={() => dispatch({ type: "layer/duplicate", id: primaryLayer.id })}
              disabled={disabled || layers.length >= MAX_LAYERS_PER_FRAME}
              className="flex-1 rounded bg-zinc-700 p-1 hover:bg-zinc-600 disabled:opacity-30"
              title="Duplicate"
            ><Copy size={13} className="mx-auto" /></button>
            <button
              onClick={() => dispatch({ type: "layer/remove", id: primaryLayer.id })}
              // The base layer is permanent. Disabled here AND refused by
              // removeLayer, because keyboard Delete does not pass through here.
              disabled={disabled || primaryLayer.kind === "base"}
              title={primaryLayer.kind === "base" ? "The base layer cannot be deleted" : "Delete layer"}
              className="flex-1 rounded bg-red-700/80 p-1 hover:bg-red-600 disabled:opacity-30"
            ><Trash2 size={13} className="mx-auto" /></button>
          </div>
        </div>
      )}
    </aside>
  );
}
