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
import { Eye, EyeOff, Lock, Unlock, Plus, Copy, Trash2, ChevronUp, ChevronDown, Layers as LayersIcon, Grid2x2Check, ImagePlus, CopyPlus, SlidersHorizontal, CornerLeftDown, RectangleCircle, Contrast, X, Check } from "lucide-react";

import type { Adjustment, AdjustmentType, BlendMode, ColorBalanceTone, Layer, LayerSelection } from "@/types/layer";
import { ADJUSTMENT_LABELS, BLEND_LABELS, BLEND_MODES } from "@/types/layer";
import type { LayerAction } from "@/lib/layers/editor";
import { BLANK_LAYER_SIZE, MAX_LAYERS_PER_FRAME } from "@/lib/layers/constants";

interface Props {
  layers: readonly Layer[];
  selection: LayerSelection;
  disabled?: boolean;
  onSelect: (id: string, mode?: "replace" | "toggle" | "add" | "range") => void;
  dispatch: (a: LayerAction) => void;
  onAddImage: () => void;
  /** Add one blank layer to every frame of the animation. */
  onAddBlankAllFrames?: () => void;
  /** Add an adjustment layer (on every frame). */
  onAddAdjustment?: (type: AdjustmentType) => void;
  /** Open one undo step; called when a slider drag starts. */
  onBeginEdit?: () => void;
  /** Paint tools target the selected layer's mask. */
  editMask?: boolean;
  onEditMaskChange?: (v: boolean) => void;
  /** Bake the layer's mask into its pixels and remove it. */
  onApplyMask?: (id: string) => void;
}

const ADJUSTMENT_TYPES: readonly AdjustmentType[] = ["brightnessContrast", "hueSaturation", "colorBalance"];

export default function LayerPanel({
  layers, selection, disabled, onSelect, dispatch, onAddImage, onAddBlankAllFrames,
  onAddAdjustment, onBeginEdit, editMask = false, onEditMaskChange, onApplyMask,
}: Props) {
  const [adjustMenu, setAdjustMenu] = useState(false);
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
        <div className="flex items-center gap-0.5">
          <button
            onClick={() =>
              dispatch({ type: "layer/add", image: null, size: { w: BLANK_LAYER_SIZE, h: BLANK_LAYER_SIZE } })
            }
            disabled={disabled || layers.length >= MAX_LAYERS_PER_FRAME}
            title="New blank layer to paint on"
            className="rounded p-1 text-zinc-300 hover:bg-zinc-700 disabled:opacity-30"
          >
            <Plus size={14} />
          </button>
          {onAddBlankAllFrames && (
            <button
              onClick={onAddBlankAllFrames}
              disabled={disabled}
              title="New blank layer on every frame"
              className="rounded p-1 text-zinc-300 hover:bg-zinc-700 disabled:opacity-30"
            >
              <CopyPlus size={14} />
            </button>
          )}
          <button
            onClick={onAddImage}
            disabled={disabled || layers.length >= MAX_LAYERS_PER_FRAME}
            title="Add layer from image"
            className="rounded p-1 text-zinc-300 hover:bg-zinc-700 disabled:opacity-30"
          >
            <ImagePlus size={14} />
          </button>
          {onAddAdjustment && (
            <div className="relative">
              <button
                onClick={() => setAdjustMenu((v) => !v)}
                disabled={disabled}
                title="New adjustment layer"
                className="rounded p-1 text-zinc-300 hover:bg-zinc-700 disabled:opacity-30"
              >
                <SlidersHorizontal size={14} />
              </button>
              {adjustMenu && (
                <div className="absolute right-0 top-full z-20 mt-1 w-40 rounded border border-white/10 bg-zinc-900 py-1 shadow-lg">
                  {ADJUSTMENT_TYPES.map((t) => (
                    <button
                      key={t}
                      onClick={() => { setAdjustMenu(false); onAddAdjustment(t); }}
                      className="block w-full px-3 py-1 text-left text-xs text-zinc-200 hover:bg-zinc-700"
                    >
                      {ADJUSTMENT_LABELS[t]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
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
              onClick={(e) => {
                onSelect(
                  layer.id,
                  e.shiftKey ? "range" : e.metaKey || e.ctrlKey ? "toggle" : "replace"
                );
                onEditMaskChange?.(false);
              }}
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

              {layer.clip && (
                <span title="Clipped to the layer below" className="-mr-1 text-zinc-400">
                  <CornerLeftDown size={12} />
                </span>
              )}
              <div
                className={`flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded border bg-[#1b1f28] ${
                  layer.mask && primary === layer.id && !editMask ? "border-white" : "border-zinc-700"
                }`}
              >
                {layer.adjust ? (
                  <SlidersHorizontal size={14} className="text-zinc-400" />
                ) : (
                  layer.image && (
                    <img src={layer.image} alt="" className="h-full w-full object-contain" />
                  )
                )}
              </div>
              {layer.mask && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(layer.id);
                    onEditMaskChange?.(true);
                  }}
                  disabled={disabled}
                  title="Layer mask: click to paint on it (white shows, black hides)"
                  className={`relative -ml-1 h-8 w-8 flex-shrink-0 overflow-hidden rounded border ${
                    primary === layer.id && editMask ? "border-white" : "border-zinc-700"
                  }`}
                  style={{
                    background:
                      (layer.mask.fill === 255) !== layer.mask.inverted ? "#ffffff" : "#000000",
                  }}
                >
                  {layer.mask.image && (
                    <img
                      src={layer.mask.image}
                      alt=""
                      className="h-full w-full object-contain"
                      style={layer.mask.inverted ? { filter: "invert(1)" } : undefined}
                    />
                  )}
                  {!layer.mask.enabled && (
                    <X size={30} className="absolute inset-0 m-auto text-red-500" />
                  )}
                </button>
              )}

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
                  {layer.blend !== "normal" && ` · ${BLEND_LABELS[layer.blend] ?? layer.blend}`}
                  {layer.alphaLock && " · alpha lock"}
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
              onPointerDown={() => { if (primaryLayer.linkId) onBeginEdit?.(); }}
              onKeyDown={(e) => { if (primaryLayer.linkId && movesSlider(e.key)) onBeginEdit?.(); }}
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

          {primaryLayer.adjust && (
            <AdjustmentControls
              value={primaryLayer.adjust}
              disabled={disabled || primaryLayer.locked}
              onBegin={() => onBeginEdit?.()}
              onChange={(value) => dispatch({ type: "layer/adjust", id: primaryLayer.id, value })}
            />
          )}

          {!primaryLayer.adjust && (
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
                <option key={m} value={m}>{BLEND_LABELS[m]}</option>
              ))}
            </select>
          </label>
          )}

          {primaryLayer.kind !== "base" && (
            <button
              onClick={() =>
                dispatch({ type: "layer/clip", id: primaryLayer.id, value: !primaryLayer.clip })
              }
              disabled={disabled || primaryLayer.locked}
              title="Clipping mask: show this layer only where the layer below has pixels"
              className={`flex w-full items-center gap-2 rounded px-2 py-1 text-[10px] disabled:opacity-40 ${
                primaryLayer.clip
                  ? "bg-indigo-500/30 text-white"
                  : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
              }`}
            >
              <CornerLeftDown size={12} />
              Clip to layer below
            </button>
          )}

          {!primaryLayer.adjust && (
          <button
            onClick={() =>
              dispatch({
                type: "layer/alphaLock",
                id: primaryLayer.id,
                value: !primaryLayer.alphaLock,
              })
            }
            disabled={disabled || primaryLayer.locked}
            title="Lock transparent pixels: paint only where this layer already has pixels"
            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-[10px] disabled:opacity-40 ${
              primaryLayer.alphaLock
                ? "bg-indigo-500/30 text-white"
                : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
            }`}
          >
            <Grid2x2Check size={12} />
            Lock transparent pixels
          </button>
          )}

          {!primaryLayer.mask ? (
            <button
              onClick={(e) =>
                dispatch({ type: "layer/maskAdd", id: primaryLayer.id, hideAll: e.altKey })
              }
              disabled={disabled || primaryLayer.locked}
              title="Add layer mask (Alt-click: a mask that hides everything)"
              className="flex w-full items-center gap-2 rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-400 hover:bg-zinc-700 disabled:opacity-40"
            >
              <RectangleCircle size={12} />
              Add mask
            </button>
          ) : (
            <div className="flex items-center gap-1 text-[10px] text-zinc-400">
              <RectangleCircle size={12} />
              <span className="flex-1">Mask</span>
              <button
                onClick={() =>
                  dispatch({ type: "layer/maskSet", id: primaryLayer.id, patch: { inverted: !primaryLayer.mask!.inverted } })
                }
                disabled={disabled || primaryLayer.locked}
                title="Invert mask (Ctrl+I)"
                className="rounded bg-zinc-800 p-1 hover:bg-zinc-700 disabled:opacity-40"
              ><Contrast size={12} /></button>
              <button
                onClick={() =>
                  dispatch({ type: "layer/maskSet", id: primaryLayer.id, patch: { enabled: !primaryLayer.mask!.enabled } })
                }
                disabled={disabled || primaryLayer.locked}
                title={primaryLayer.mask.enabled ? "Turn mask off" : "Turn mask on"}
                className={`rounded p-1 disabled:opacity-40 ${
                  primaryLayer.mask.enabled ? "bg-zinc-800 hover:bg-zinc-700" : "bg-red-900/60 text-white"
                }`}
              >{primaryLayer.mask.enabled ? <Eye size={12} /> : <EyeOff size={12} />}</button>
              {onApplyMask && !primaryLayer.adjust && (
                <button
                  onClick={() => onApplyMask(primaryLayer.id)}
                  disabled={disabled || primaryLayer.locked || !primaryLayer.mask.enabled}
                  title={
                    primaryLayer.mask.enabled
                      ? "Apply mask: bake it into the layer's pixels"
                      : "Turn the mask on to apply it"
                  }
                  className="rounded bg-zinc-800 p-1 hover:bg-zinc-700 disabled:opacity-40"
                ><Check size={12} /></button>
              )}
              <button
                onClick={() => dispatch({ type: "layer/maskDelete", id: primaryLayer.id })}
                disabled={disabled || primaryLayer.locked}
                title="Delete mask"
                className="rounded bg-zinc-800 p-1 hover:bg-red-700 disabled:opacity-40"
              ><Trash2 size={12} /></button>
            </div>
          )}

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

/* ---------------- adjustment sliders ---------------- */

/** Keys that change a range input's value (and so start an undo step). */
const movesSlider = (key: string) =>
  ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(key);

function Slider({
  label, value, min, max, disabled, onBegin, onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onBegin: () => void;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block text-[10px] text-zinc-400">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="text-zinc-300">{value > 0 ? `+${value}` : value}</span>
      </span>
      <input
        type="range" min={min} max={max} step={1}
        value={value}
        disabled={disabled}
        onPointerDown={onBegin}
        onKeyDown={(e) => { if (movesSlider(e.key)) onBegin(); }}
        onDoubleClick={() => { onBegin(); onChange(0); }}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-indigo-500 disabled:opacity-40"
      />
    </label>
  );
}

type Tone = "shadows" | "midtones" | "highlights";
const TONES: readonly Tone[] = ["shadows", "midtones", "highlights"];
const BALANCE_LABELS = ["Cyan – Red", "Magenta – Green", "Yellow – Blue"] as const;

function AdjustmentControls({
  value, disabled, onBegin, onChange,
}: {
  value: Adjustment;
  disabled?: boolean;
  onBegin: () => void;
  onChange: (v: Adjustment) => void;
}) {
  const [tone, setTone] = useState<Tone>("midtones");
  const common = { disabled, onBegin };

  if (value.type === "brightnessContrast") {
    return (
      <div className="space-y-1">
        <Slider {...common} label="Brightness" min={-100} max={100} value={value.brightness}
          onChange={(v) => onChange({ ...value, brightness: v })} />
        <Slider {...common} label="Contrast" min={-100} max={100} value={value.contrast}
          onChange={(v) => onChange({ ...value, contrast: v })} />
      </div>
    );
  }

  if (value.type === "hueSaturation") {
    return (
      <div className="space-y-1">
        <Slider {...common} label="Hue" min={-180} max={180} value={value.hue}
          onChange={(v) => onChange({ ...value, hue: v })} />
        <Slider {...common} label="Saturation" min={-100} max={100} value={value.saturation}
          onChange={(v) => onChange({ ...value, saturation: v })} />
        <Slider {...common} label="Lightness" min={-100} max={100} value={value.lightness}
          onChange={(v) => onChange({ ...value, lightness: v })} />
      </div>
    );
  }

  const current: ColorBalanceTone = value[tone];
  return (
    <div className="space-y-1">
      <div className="flex gap-0.5">
        {TONES.map((t) => (
          <button
            key={t}
            onClick={() => setTone(t)}
            className={`flex-1 rounded py-0.5 text-[10px] capitalize ${
              tone === t ? "bg-indigo-500/30 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      {BALANCE_LABELS.map((label, c) => (
        <Slider {...common} key={label} label={label} min={-100} max={100} value={current[c]}
          onChange={(v) => {
            const next = [...current] as [number, number, number];
            next[c] = v;
            onChange({ ...value, [tone]: next });
          }} />
      ))}
    </div>
  );
}
