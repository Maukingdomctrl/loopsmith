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
import { Eye, EyeOff, Lock, LockOpen, Plus, Copy, Trash2, ChevronDown, ChevronRight, ChevronsRight, Folder, FolderOpen, ArrowUp, ArrowDown, FolderPlus, ImagePlus, CopyPlus, SlidersHorizontal, CornerLeftDown, Contrast, X, Check } from "lucide-react";

import type { Adjustment, AdjustmentType, BlendMode, ColorBalanceTone, Layer, LayerSelection } from "@/types/layer";
import { ADJUSTMENT_LABELS, BLEND_LABELS, BLEND_MODES } from "@/types/layer";
import type { LayerAction } from "@/lib/layers/editor";
import { BLANK_LAYER_SIZE, MAX_LAYERS_PER_FRAME } from "@/lib/layers/constants";
import { maskTone, rangeFill } from "@/styles/tokens";
import { ancestorsOf } from "@/lib/layers/groups";

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
  /** Collapse the panel to its rail. */
  onCollapse?: () => void;
  /** New empty group (on every frame). */
  onAddGroup?: () => void;
}

const ADJUSTMENT_TYPES: readonly AdjustmentType[] = ["brightnessContrast", "hueSaturation", "colorBalance"];

export default function LayerPanel({
  layers, selection, disabled, onSelect, dispatch, onAddImage, onAddBlankAllFrames,
  onAddAdjustment, onBeginEdit, editMask = false, onEditMaskChange, onApplyMask, onCollapse, onAddGroup,
}: Props) {
  const [addMenu, setAddMenu] = useState(false);
  // Reverse for display only. The index handed back to `moveLayer` is always
  // recomputed against the real array.
  const rows = useMemo(() => [...layers].reverse(), [layers]);
  const dragFrom = useRef<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  /** Where a dragged row would land: above a row, or into a group. */
  const [dropAt, setDropAt] = useState<{ id: string; into: boolean } | null>(null);
  const handleDrop = useCallback(
    (targetId: string, into: boolean) => {
      const from = dragFrom.current;
      dragFrom.current = null;
      setDropAt(null);
      if (!from || from === targetId) return;
      dispatch({ type: "layer/drop", id: from, targetId, into });
    },
    [dispatch]
  );
  /** Over the lower half of a group row, a drop goes into the group. */
  const dropsInto = (e: React.DragEvent<HTMLElement>, layer: Layer) => {
    if (layer.kind !== "group") return false;
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientY > r.top + r.height / 2;
  };

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
  const full = layers.length >= MAX_LAYERS_PER_FRAME;
  // Rows top-first; layers inside a folded group are hidden.
  const stack = rows.filter(
    (l) => l.kind !== "base" && !ancestorsOf(layers, l).some((g) => g.collapsed)
  );
  const base = rows.find((l) => l.kind === "base") ?? null;

  const setOpacity = (layer: Layer, value: number) => {
    if (layer.linkId) onBeginEdit?.();
    dispatch({ type: "layer/opacity", id: layer.id, value });
  };

  const renderRow = (layer: Layer) => {
    const isSelected = selection.ids.includes(layer.id);
    const isBase = layer.kind === "base";
    const isGroup = layer.kind === "group";
    const ancestors = ancestorsOf(layers, layer);
    const depth = ancestors.length;
    /** Hidden or locked by a group it sits in (its own switch may be on). */
    const hiddenByGroup = ancestors.some((g) => !g.visible);
    const lockedByGroup = ancestors.some((g) => g.locked);
    const shown = layer.visible && !hiddenByGroup;
    const childCount = isGroup ? layers.filter((l) => l.parentId === layer.id).length : 0;
    const drop = dropAt?.id === layer.id ? dropAt : null;
    const opacity = Math.round(layer.opacity * 100);
    const details = [
      `${opacity}% opacity`,
      layer.blend !== "normal" ? BLEND_LABELS[layer.blend] ?? layer.blend : null,
      layer.alphaLock ? "transparent pixels locked" : null,
      layer.crop ? "cropped" : null,
    ].filter(Boolean).join(" · ");

    return (
      <div
        key={layer.id}
        draggable={!isBase && !disabled}
        onDragStart={() => { dragFrom.current = layer.id; }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const into = dropsInto(e, layer);
          if (drop?.into !== into) setDropAt({ id: layer.id, into });
        }}
        onDragLeave={() => { if (drop) setDropAt(null); }}
        onDrop={(e) => { e.preventDefault(); handleDrop(layer.id, dropsInto(e, layer)); }}
        onDragEnd={() => setDropAt(null)}
        onClick={(e) => {
          onSelect(
            layer.id,
            e.shiftKey ? "range" : e.metaKey || e.ctrlKey ? "toggle" : "replace"
          );
          onEditMaskChange?.(false);
        }}
        title={isGroup ? `${childCount} layer${childCount === 1 ? "" : "s"} · ${opacity}% opacity` : details}
        className={`relative flex h-10 cursor-pointer items-center gap-2 rounded-ctrl pr-1 ${
          isSelected ? "selected" : "hoverable"
        } ${drop?.into ? "ring-1 ring-inset ring-accent" : ""}`}
        style={{ paddingLeft: 8 + depth * 11 }}
      >
        {/* Where a dragged layer will land: a line above this row. */}
        {drop && !drop.into && (
          <span className="pointer-events-none absolute inset-x-1 -top-px h-0.5 rounded-full bg-accent" />
        )}
        {/* One guide line per level of nesting. */}
        {ancestors.map((_, i) => (
          <span
            key={i}
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-track"
            style={{ left: 8 + (depth - 1 - i) * 11 + 5 }}
          />
        ))}
        {isGroup ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              dispatch({ type: "layer/collapse", id: layer.id, value: !layer.collapsed });
            }}
            aria-label={layer.collapsed ? `Open ${layer.name}` : `Fold ${layer.name}`}
            aria-expanded={!layer.collapsed}
            className="-ml-1 flex h-6 w-5 shrink-0 items-center justify-center rounded-[5px] text-icon hoverable"
          >
            <ChevronRight size={14} className={`transition-transform duration-150 ${layer.collapsed ? "" : "rotate-90"}`} />
          </button>
        ) : (
          depth > 0 && <span className="-ml-1 w-5 shrink-0" />
        )}
        {layer.clip && (
          <span title="Clipped to the layer below" className="-mr-1 text-ink-3">
            <CornerLeftDown size={12} />
          </span>
        )}
        {isGroup ? (
          layer.collapsed ? (
            <Folder size={17} className={`shrink-0 text-icon-accent ${shown ? "" : "opacity-40"}`} />
          ) : (
            <FolderOpen size={17} className={`shrink-0 text-icon-accent ${shown ? "" : "opacity-40"}`} />
          )
        ) : (
        <div
          className={`flex h-7 w-7 flex-shrink-0 items-center justify-center overflow-hidden rounded-[6px] border bg-ctrl ${
            layer.mask && primary === layer.id && !editMask ? "border-select-line" : "border-line"
          } ${shown ? "" : "opacity-40"}`}
        >
          {layer.adjust ? (
            <SlidersHorizontal size={13} className="text-icon" />
          ) : (
            layer.image && (
              <img src={layer.image} alt="" className="h-full w-full object-contain" />
            )
          )}
        </div>
        )}
        {layer.mask && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSelect(layer.id);
              onEditMaskChange?.(true);
            }}
            disabled={disabled}
            title="Layer mask: click to paint on it (white shows, black hides)"
            aria-label={`Paint on ${layer.name} mask`}
            className={`relative -ml-1 h-7 w-7 flex-shrink-0 overflow-hidden rounded-[6px] border ${
              primary === layer.id && editMask ? "border-select-line" : "border-line"
            }`}
            style={{
              background:
                (layer.mask.fill === 255) !== layer.mask.inverted ? maskTone.show : maskTone.hide,
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
              <X size={26} className="absolute inset-0 m-auto text-danger" />
            )}
          </button>
        )}

        <div className="flex min-w-0 flex-1 items-center gap-2">
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
              aria-label="Layer name"
              className="w-full rounded-ctrl bg-ctrl px-1.5 py-0.5 text-[14px] text-ink outline-none"
            />
          ) : (
            <span
              onDoubleClick={(e) => {
                e.stopPropagation();
                setRenamingId(layer.id);
                setDraft(layer.name);
              }}
              className={`truncate text-[14px] ${
                isSelected ? "font-semibold text-ink" : "font-medium text-ink"
              } ${shown ? "" : "text-ink-dim"}`}
            >
              {layer.name}
            </span>
          )}
          {isGroup && renamingId !== layer.id && (
            <span className="shrink-0 rounded-[5px] bg-ctrl px-1.5 py-px font-mono text-[11px] text-ink-2">
              {childCount}
            </span>
          )}
          {opacity < 100 && renamingId !== layer.id && (
            <span className="shrink-0 rounded-[5px] bg-warn-bg px-1.5 py-px font-mono text-[11px] font-medium text-warn">
              {opacity}%
            </span>
          )}
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            dispatch({ type: "layer/visible", id: layer.id, value: !layer.visible });
          }}
          disabled={disabled}
          title={layer.visible ? "Hide" : "Show"}
          aria-label={layer.visible ? `Hide ${layer.name}` : `Show ${layer.name}`}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-ctrl hoverable disabled:opacity-30 ${
            layer.visible && !hiddenByGroup ? "text-icon" : "text-ink-dim"
          }`}
        >
          {layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            dispatch({ type: "layer/locked", id: layer.id, value: !layer.locked });
          }}
          disabled={disabled}
          title={layer.locked ? "Unlock" : "Lock"}
          aria-label={layer.locked ? `Unlock ${layer.name}` : `Lock ${layer.name}`}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-ctrl hoverable disabled:opacity-30 ${
            layer.locked || lockedByGroup ? "text-icon" : "text-ink-dim"
          }`}
        >
          {layer.locked ? <Lock size={14} /> : <LockOpen size={14} />}
        </button>
      </div>
    );
  };

  const settingsTitle = !primaryLayer
    ? ""
    : primaryLayer.kind === "base"
      ? "Base settings"
      : primaryLayer.kind === "group"
        ? "Group settings"
      : primaryLayer.adjust
        ? `${ADJUSTMENT_LABELS[primaryLayer.adjust.type]} settings`
        : "Layer settings";

  const tile =
    "flex h-10 items-center justify-center gap-2 rounded-ctrl bg-ctrl text-[13px] font-semibold text-ink hoverable disabled:opacity-30";

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-l border-line bg-panel">
      <div className="flex h-[52px] shrink-0 items-center gap-1 border-b border-line pl-4 pr-2">
        <h2 className="section-title">Layers</h2>
        <span className="ml-2 flex-1 text-[12px] text-ink-2">
          <span className="font-mono">{layers.length}</span> of{" "}
          <span className="font-mono">{MAX_LAYERS_PER_FRAME}</span>
        </span>

        <div
          className="relative"
          onKeyDown={(e) => { if (e.key === "Escape") setAddMenu(false); }}
        >
          <button
            onClick={() => setAddMenu((v) => !v)}
            disabled={disabled}
            title="New layer"
            aria-label="New layer"
            aria-haspopup="menu"
            aria-expanded={addMenu}
            className="flex h-8 w-8 items-center justify-center rounded-ctrl text-icon hoverable disabled:opacity-30"
          >
            <Plus size={17} />
          </button>
          {addMenu && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setAddMenu(false)} />
              <div
                role="menu"
                className="absolute right-0 top-full z-30 mt-1 w-56 rounded-panel border border-line-strong bg-ctrl p-1 shadow-flyout"
              >
                <MenuItem
                  icon={<Plus size={14} />}
                  label="Blank layer"
                  disabled={full}
                  onClick={() => {
                    setAddMenu(false);
                    dispatch({ type: "layer/add", image: null, size: { w: BLANK_LAYER_SIZE, h: BLANK_LAYER_SIZE } });
                  }}
                />
                {onAddBlankAllFrames && (
                  <MenuItem
                    icon={<CopyPlus size={14} />}
                    label="Blank layer on every frame"
                    onClick={() => { setAddMenu(false); onAddBlankAllFrames(); }}
                  />
                )}
                <MenuItem
                  icon={<ImagePlus size={14} />}
                  label="Layer from image…"
                  disabled={full}
                  onClick={() => { setAddMenu(false); onAddImage(); }}
                />
                {onAddAdjustment && (
                  <>
                    <div className="mx-2 my-1 h-px bg-line-strong" />
                    <div className="px-2.5 pb-1 pt-1.5 section-title">Adjustment layer</div>
                    {ADJUSTMENT_TYPES.map((t) => (
                      <MenuItem
                        key={t}
                        icon={<SlidersHorizontal size={14} />}
                        label={ADJUSTMENT_LABELS[t]}
                        onClick={() => { setAddMenu(false); onAddAdjustment(t); }}
                      />
                    ))}
                  </>
                )}
              </div>
            </>
          )}
        </div>
        {(() => {
          // With several layers picked, the folder button groups them;
          // otherwise it makes a new, empty group.
          const grouping = selection.ids.filter((id) => id !== base?.id).length >= 2;
          return (
            <button
              onClick={() =>
                grouping
                  ? dispatch({ type: "layer/group", ids: selection.ids })
                  : onAddGroup?.()
              }
              disabled={disabled || full || (!grouping && !onAddGroup)}
              title={grouping ? "Group selected layers (Ctrl+G)" : "New group"}
              aria-label={grouping ? "Group selected layers" : "New group"}
              className="flex h-8 w-8 items-center justify-center rounded-ctrl text-icon hoverable disabled:opacity-30"
            >
              <FolderPlus size={16} />
            </button>
          );
        })()}
        {onCollapse && (
          <>
            <span className="mx-1 h-5 w-px bg-line" />
            <button
              onClick={onCollapse}
              title="Collapse layers"
              aria-label="Collapse layers panel"
              className="flex h-8 w-8 items-center justify-center rounded-ctrl text-icon hoverable"
            >
              <ChevronsRight size={17} />
            </button>
          </>
        )}
      </div>

      <div className="min-h-[132px] flex-1 basis-0 space-y-0.5 overflow-y-auto px-2 py-3">
        {stack.map(renderRow)}
        {stack.length === 0 && (
          <p className="px-2 py-2 text-[12px] leading-relaxed text-ink-3">
            Only the base layer so far. Use + to add one.
          </p>
        )}
      </div>

      {base && (
        <div className="shrink-0 border-t border-line px-2 pb-3 pt-3">
          <div className="section-title mb-2 px-2">Base layer</div>
          {renderRow(base)}
        </div>
      )}

      {/* Settings for the primary selection. */}
      {primaryLayer && (
        <div className="min-h-0 shrink space-y-4 overflow-y-auto border-t border-line px-4 pb-4 pt-4">
          <div className="section-title">{settingsTitle}</div>

          <div>
            <div className="mb-1.5 flex items-baseline gap-3">
              <span className="flex-1 text-[14px] font-medium text-ink">Opacity</span>
              {primaryLayer.opacity < 1 && (
                <button
                  onClick={() => setOpacity(primaryLayer, 1)}
                  disabled={disabled || primaryLayer.locked}
                  className="text-[13px] font-semibold text-accent hover:text-accent-hi disabled:opacity-40"
                >
                  Reset
                </button>
              )}
              <span className="w-10 text-right font-mono text-[14px] text-ink">
                {Math.round(primaryLayer.opacity * 100)}%
              </span>
            </div>
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
              aria-label="Layer opacity"
              className="w-full"
              style={rangeFill(Math.round(primaryLayer.opacity * 100), 0, 100)}
            />
          </div>

          {primaryLayer.adjust && (
            <AdjustmentControls
              value={primaryLayer.adjust}
              disabled={disabled || primaryLayer.locked}
              onBegin={() => onBeginEdit?.()}
              onChange={(value) => dispatch({ type: "layer/adjust", id: primaryLayer.id, value })}
            />
          )}

          {primaryLayer.kind === "group" && (
            <>
              <div
                className="flex h-10 items-center rounded-ctrl border border-line bg-panel px-3"
                title="Each layer in the group keeps its own blend mode"
              >
                <span className="flex-1 text-[14px] text-ink-2">Blend</span>
                <span className="text-[14px] font-semibold text-ink">Pass through</span>
              </div>
              <button
                onClick={() => dispatch({ type: "layer/ungroup", id: primaryLayer.id })}
                disabled={disabled}
                title="Ungroup (Ctrl+Shift+G): keep the layers, remove the folder"
                className={`${tile} w-full`}
              >
                <FolderOpen size={14} />
                Ungroup
              </button>
            </>
          )}

          {!primaryLayer.adjust && primaryLayer.kind !== "group" && (
            <label className="relative flex h-10 items-center rounded-ctrl border border-line bg-panel px-3 hoverable">
              <span className="flex-1 text-[14px] text-ink-2">Blend</span>
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
                className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
                aria-label="Blend mode"
              >
                {BLEND_MODES.map((m) => (
                  <option key={m} value={m}>{BLEND_LABELS[m]}</option>
                ))}
              </select>
              <span className="text-[14px] font-semibold text-ink">{BLEND_LABELS[primaryLayer.blend]}</span>
              <ChevronDown size={15} className="ml-1.5 text-icon" />
            </label>
          )}

          {primaryLayer.kind !== "group" && (
          <div className="grid grid-cols-2 gap-2">
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
                aria-pressed={primaryLayer.alphaLock}
                title="Lock transparent pixels: paint only where this layer already has pixels"
                className={`${tile} ${primaryLayer.alphaLock ? "selected text-icon-on" : ""}`}
              >
                <Lock size={14} />
                Lock pixels
              </button>
            )}

            {!primaryLayer.mask ? (
              <button
                onClick={(e) =>
                  dispatch({ type: "layer/maskAdd", id: primaryLayer.id, hideAll: e.altKey })
                }
                disabled={disabled || primaryLayer.locked}
                title="Add layer mask (Alt-click: a mask that hides everything)"
                className={tile}
              >
                <Contrast size={14} />
                Add mask
              </button>
            ) : (
              <div className="flex h-10 items-center gap-1 rounded-ctrl bg-ctrl px-1.5" title="Layer mask">
                <span className="flex-1 pl-1 text-[13px] font-semibold text-ink">Mask</span>
                <button
                  onClick={() =>
                    dispatch({ type: "layer/maskSet", id: primaryLayer.id, patch: { inverted: !primaryLayer.mask!.inverted } })
                  }
                  disabled={disabled || primaryLayer.locked}
                  title="Invert mask (Ctrl+I)"
                  aria-label="Invert mask"
                  className="rounded-ctrl p-1 text-icon hoverable disabled:opacity-40"
                ><Contrast size={13} /></button>
                <button
                  onClick={() =>
                    dispatch({ type: "layer/maskSet", id: primaryLayer.id, patch: { enabled: !primaryLayer.mask!.enabled } })
                  }
                  disabled={disabled || primaryLayer.locked}
                  title={primaryLayer.mask.enabled ? "Turn mask off" : "Turn mask on"}
                  aria-label={primaryLayer.mask.enabled ? "Turn mask off" : "Turn mask on"}
                  className={`rounded-ctrl p-1 disabled:opacity-40 ${
                    primaryLayer.mask.enabled ? "text-icon hoverable" : "bg-danger-bg text-danger-strong"
                  }`}
                >{primaryLayer.mask.enabled ? <Eye size={13} /> : <EyeOff size={13} />}</button>
                {onApplyMask && !primaryLayer.adjust && (
                  <button
                    onClick={() => onApplyMask(primaryLayer.id)}
                    disabled={disabled || primaryLayer.locked || !primaryLayer.mask.enabled}
                    title={
                      primaryLayer.mask.enabled
                        ? "Apply mask: bake it into the layer's pixels"
                        : "Turn the mask on to apply it"
                    }
                    aria-label="Apply mask"
                    className="rounded-ctrl p-1 text-icon hoverable disabled:opacity-40"
                  ><Check size={13} /></button>
                )}
                <button
                  onClick={() => dispatch({ type: "layer/maskDelete", id: primaryLayer.id })}
                  disabled={disabled || primaryLayer.locked}
                  title="Delete mask"
                  aria-label="Delete mask"
                  className="rounded-ctrl p-1 text-danger hover:bg-danger-bg hover:text-danger-strong disabled:opacity-40"
                ><Trash2 size={13} /></button>
              </div>
            )}

            {primaryLayer.kind !== "base" && (
              <button
                onClick={() =>
                  dispatch({ type: "layer/clip", id: primaryLayer.id, value: !primaryLayer.clip })
                }
                disabled={disabled || primaryLayer.locked}
                aria-pressed={primaryLayer.clip}
                title="Clipping mask: show this layer only where the layer below has pixels"
                className={`${tile} col-span-2 ${primaryLayer.clip ? "selected text-icon-on" : ""}`}
              >
                <CornerLeftDown size={14} />
                Clip to layer below
              </button>
            )}
          </div>
          )}

          <div className="grid grid-cols-4 gap-2">
            <button
              onClick={() => dispatch({ type: "layer/raise", id: primaryLayer.id })}
              disabled={disabled || primaryLayer.kind === "base"}
              className={`${tile} text-icon`}
              title="Move up"
              aria-label="Move layer up"
            ><ArrowUp size={16} /></button>
            <button
              onClick={() => dispatch({ type: "layer/lower", id: primaryLayer.id })}
              disabled={disabled || primaryLayer.kind === "base"}
              className={`${tile} text-icon`}
              title="Move down"
              aria-label="Move layer down"
            ><ArrowDown size={16} /></button>
            <button
              onClick={() => dispatch({ type: "layer/duplicate", id: primaryLayer.id })}
              disabled={disabled || full}
              className={`${tile} text-icon`}
              title="Duplicate"
              aria-label="Duplicate layer"
            ><Copy size={15} /></button>
            <button
              onClick={() => dispatch({ type: "layer/remove", id: primaryLayer.id })}
              // The base layer is permanent. Disabled here AND refused by
              // removeLayer, because keyboard Delete does not pass through here.
              disabled={disabled || primaryLayer.kind === "base"}
              title={primaryLayer.kind === "base" ? "The base layer cannot be deleted" : "Delete layer"}
              aria-label="Delete layer"
              className="flex h-10 items-center justify-center rounded-ctrl border border-danger-line bg-danger-bg text-danger-strong hoverable disabled:opacity-30"
            ><Trash2 size={15} /></button>
          </div>
        </div>
      )}
    </aside>
  );
}

function MenuItem({
  icon, label, onClick, disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2.5 rounded-ctrl px-2.5 py-2 text-left text-[13px] text-ink hoverable disabled:opacity-40"
    >
      <span className="text-icon">{icon}</span>
      {label}
    </button>
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
    <label className="block text-[11px] text-ink-2">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="text-ink">{value > 0 ? `+${value}` : value}</span>
      </span>
      <input
        type="range" min={min} max={max} step={1}
        value={value}
        disabled={disabled}
        onPointerDown={onBegin}
        onKeyDown={(e) => { if (movesSlider(e.key)) onBegin(); }}
        onDoubleClick={() => { onBegin(); onChange(0); }}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full  disabled:opacity-40"
        style={rangeFill(value, min, max)}
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
            className={`flex-1 rounded-ctrl py-0.5 text-[11px] capitalize ${
              tone === t ? "selected text-ink" : "bg-ctrl text-ink-2 hoverable"
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
