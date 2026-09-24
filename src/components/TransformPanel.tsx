"use client";

/**
 * Numeric transform controls, including the 0–360° rotation system.
 *
 * Every field is a DRAFT until blur/Enter. That matters for rotation: typing
 * "18" on the way to "180" must not rotate the layer to 18° and back, because
 * each intermediate commit would be an undo step and the artwork would visibly
 * flicker. The draft pattern is the same one the existing zoom input uses.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Maximize2, FlipHorizontal2, FlipVertical2, Crosshair, AlignCenter, Ruler } from "lucide-react";

import type { Layer } from "@/types/layer";
import type { LayerAction } from "@/lib/layers/editor";
import { normalizeAngle, parseAngleInput } from "@/lib/geometry/angle";
import { fitScale, CANVAS_SIZE } from "@/lib/frameTransform";
import { roundTo } from "@/lib/geometry/scalar";
import { ROTATE_STEP, ROTATE_STEP_FINE, ROTATE_SNAP_STEP } from "@/lib/layers/constants";

interface Props {
  layer: Layer | null;
  disabled?: boolean;
  dispatch: (a: LayerAction) => void;
  onStraightenTool: () => void;
  onCropTool: () => void;
}

const PIVOT_ANCHORS: { label: string; anchor: { x: number; y: number } }[] = [
  { label: "↖", anchor: { x: 0, y: 0 } },
  { label: "↑", anchor: { x: 0.5, y: 0 } },
  { label: "↗", anchor: { x: 1, y: 0 } },
  { label: "←", anchor: { x: 0, y: 0.5 } },
  { label: "•", anchor: { x: 0.5, y: 0.5 } },
  { label: "→", anchor: { x: 1, y: 0.5 } },
  { label: "↙", anchor: { x: 0, y: 1 } },
  { label: "↓", anchor: { x: 0.5, y: 1 } },
  { label: "↘", anchor: { x: 1, y: 1 } },
];

export default function TransformPanel({
  layer, disabled, dispatch, onStraightenTool, onCropTool,
}: Props) {
  const locked = !layer || layer.locked || disabled;

  /** `zoom` is scale relative to the layer's own contain-fit, so the number in
   *  this field means the same thing it always did in the old UI. */
  const baseScale = useMemo(
    () => (layer && layer.size.w ? fitScale(layer.size.w, layer.size.h, CANVAS_SIZE) : 1),
    [layer]
  );
  const zoom = layer ? Math.abs(layer.pose.scale.x) / baseScale : 1;

  const [drafts, setDrafts] = useState({ x: "", y: "", rot: "", zoom: "" });
  const [editing, setEditing] = useState<keyof typeof drafts | null>(null);

  // Live values flow in only for fields that are not being typed into.
  useEffect(() => {
    if (!layer) return;
    setDrafts((d) => ({
      x: editing === "x" ? d.x : String(roundTo(layer.pose.position.x, 1)),
      y: editing === "y" ? d.y : String(roundTo(layer.pose.position.y, 1)),
      rot: editing === "rot" ? d.rot : String(roundTo(layer.pose.rotation, 1)),
      zoom: editing === "zoom" ? d.zoom : String(Math.round(zoom * 100)),
    }));
  }, [layer, zoom, editing]);

  const commitField = useCallback(
    (field: keyof typeof drafts) => {
      setEditing(null);
      if (!layer || locked) return;
      const raw = drafts[field].trim();
      if (!raw) return;

      if (field === "rot") {
        dispatch({ type: "xf/rotateTo", id: layer.id, deg: parseAngleInput(raw, layer.pose.rotation) });
        return;
      }
      const v = Number(raw);
      if (!Number.isFinite(v)) return;

      if (field === "zoom") {
        dispatch({ type: "xf/zoomTo", id: layer.id, zoom: Math.max(0.01, v / 100), baseScale });
        return;
      }
      dispatch({
        type: "xf/position",
        id: layer.id,
        position: {
          x: field === "x" ? v : layer.pose.position.x,
          y: field === "y" ? v : layer.pose.position.y,
        },
      });
    },
    [baseScale, dispatch, drafts, layer, locked]
  );

  /* ---- rotation dial ---- */
  const dialRef = useRef<HTMLDivElement>(null);
  const dialDragging = useRef(false);

  const dialAngleFrom = (e: PointerEvent | React.PointerEvent): number => {
    const el = dialRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // +90 so that "up" reads as 0°, which is what the numeric field shows.
    return normalizeAngle(
      (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI + 90
    );
  };

  const onDialDown = (e: React.PointerEvent) => {
    if (locked || !layer) return;
    dialDragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    dispatch({ type: "xf/rotateTo", id: layer.id, deg: dialAngleFrom(e) });
  };

  const onDialMove = (e: React.PointerEvent) => {
    if (!dialDragging.current || locked || !layer) return;
    const a = dialAngleFrom(e);
    // Shift snaps to 15° increments — the same step the on-canvas handle uses.
    dispatch({
      type: "xf/rotateTo",
      id: layer.id,
      deg: e.shiftKey ? Math.round(a / ROTATE_SNAP_STEP) * ROTATE_SNAP_STEP : a,
    });
  };

  const onDialUp = (e: React.PointerEvent) => {
    dialDragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const bump = (delta: number) => {
    if (!layer || locked) return;
    dispatch({ type: "xf/rotateTo", id: layer.id, deg: layer.pose.rotation + delta });
  };

  const rotation = layer?.pose.rotation ?? 0;

  return (
    <div className="space-y-3 border-t border-white/10 p-3 text-xs">
      <div className="flex items-center justify-between text-[10px] font-medium tracking-wide text-zinc-400">
        TRANSFORM
        {layer && <span className="text-zinc-500">{layer.name}</span>}
      </div>

      {/* Position */}
      <div className="grid grid-cols-2 gap-2">
        {(["x", "y"] as const).map((f) => (
          <label key={f} className="text-[10px] text-zinc-400">
            {f.toUpperCase()}
            <input
              value={drafts[f]}
              disabled={locked}
              onFocus={() => setEditing(f)}
              onChange={(e) => setDrafts((d) => ({ ...d, [f]: e.target.value }))}
              onBlur={() => commitField(f)}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              className="mt-0.5 w-full rounded bg-zinc-800 px-1.5 py-1 text-white outline-none disabled:opacity-40"
            />
          </label>
        ))}
      </div>

      {/* Scale */}
      <label className="block text-[10px] text-zinc-400">
        Scale %
        <div className="mt-0.5 flex gap-1">
          <input
            value={drafts.zoom}
            disabled={locked}
            onFocus={() => setEditing("zoom")}
            onChange={(e) => setDrafts((d) => ({ ...d, zoom: e.target.value }))}
            onBlur={() => commitField("zoom")}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="w-full rounded bg-zinc-800 px-1.5 py-1 text-white outline-none disabled:opacity-40"
          />
          <button
            onClick={() => layer && dispatch({ type: "xf/fit", id: layer.id })}
            disabled={locked}
            title="Fit to canvas"
            className="rounded bg-zinc-700 px-2 hover:bg-zinc-600 disabled:opacity-30"
          ><Maximize2 size={13} /></button>
        </div>
        <input
          type="range" min={5} max={400} step={1}
          value={Math.round(zoom * 100)}
          disabled={locked}
          onChange={(e) =>
            layer &&
            dispatch({
              type: "xf/zoomTo",
              id: layer.id,
              zoom: Number(e.target.value) / 100,
              baseScale,
            })
          }
          className="mt-1 w-full accent-indigo-500 disabled:opacity-40"
        />
      </label>

      {/* Rotation: dial + 0–360 field, both driving setLayerRotation */}
      <div className="flex items-center gap-3">
        <div
          ref={dialRef}
          onPointerDown={onDialDown}
          onPointerMove={onDialMove}
          onPointerUp={onDialUp}
          onPointerCancel={onDialUp}
          className={`relative h-14 w-14 flex-shrink-0 rounded-full border border-zinc-600 bg-[#1b1f28] ${
            locked ? "opacity-40" : "cursor-grab active:cursor-grabbing"
          }`}
          style={{ touchAction: "none" }}
          title="Drag to rotate · Shift snaps to 15°"
        >
          <div
            className="absolute left-1/2 top-1/2 h-5 w-0.5 origin-bottom -translate-x-1/2 -translate-y-full bg-cyan-400"
            style={{ transform: `translate(-50%, -100%) rotate(${rotation}deg)`, transformOrigin: "bottom center" }}
          />
          <div className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-300" />
        </div>

        <div className="flex-1 space-y-1">
          <label className="block text-[10px] text-zinc-400">
            Rotation (0–360°)
            <input
              value={drafts.rot}
              disabled={locked}
              onFocus={() => setEditing("rot")}
              onChange={(e) => setDrafts((d) => ({ ...d, rot: e.target.value }))}
              onBlur={() => commitField("rot")}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              className="mt-0.5 w-full rounded bg-zinc-800 px-1.5 py-1 text-white outline-none disabled:opacity-40"
            />
          </label>
          <div className="flex gap-1">
            <button onClick={() => bump(-ROTATE_STEP)} disabled={locked}
              className="flex-1 rounded bg-zinc-700 py-0.5 hover:bg-zinc-600 disabled:opacity-30">−1°</button>
            <button onClick={() => bump(-ROTATE_STEP_FINE)} disabled={locked}
              className="flex-1 rounded bg-zinc-700 py-0.5 hover:bg-zinc-600 disabled:opacity-30">−.1</button>
            <button onClick={() => bump(ROTATE_STEP_FINE)} disabled={locked}
              className="flex-1 rounded bg-zinc-700 py-0.5 hover:bg-zinc-600 disabled:opacity-30">+.1</button>
            <button onClick={() => bump(ROTATE_STEP)} disabled={locked}
              className="flex-1 rounded bg-zinc-700 py-0.5 hover:bg-zinc-600 disabled:opacity-30">+1°</button>
          </div>
          <div className="flex gap-1">
            <button onClick={() => bump(-90)} disabled={locked}
              className="flex-1 rounded bg-zinc-700 py-0.5 hover:bg-zinc-600 disabled:opacity-30">−90°</button>
            <button onClick={() => bump(90)} disabled={locked}
              className="flex-1 rounded bg-zinc-700 py-0.5 hover:bg-zinc-600 disabled:opacity-30">+90°</button>
            <button
              onClick={onStraightenTool}
              disabled={locked}
              title="Draw a line that should be horizontal"
              className="flex-1 rounded bg-cyan-700 py-0.5 hover:bg-cyan-600 disabled:opacity-30"
            ><Ruler size={12} className="mx-auto" /></button>
          </div>
        </div>
      </div>

      {/* Pivot */}
      <div>
        <div className="mb-1 flex items-center gap-1 text-[10px] text-zinc-400">
          <Crosshair size={11} /> Pivot
          <span className="ml-auto text-zinc-500">
            {layer ? `${roundTo(layer.pose.pivot.x, 1)}, ${roundTo(layer.pose.pivot.y, 1)}` : "—"}
          </span>
        </div>
        {/* Repinning never moves the artwork — see repinPivot. */}
        <div className="grid grid-cols-3 gap-1">
          {PIVOT_ANCHORS.map((p) => (
            <button
              key={p.label}
              onClick={() => layer && dispatch({ type: "xf/pivotAnchor", id: layer.id, anchor: p.anchor })}
              disabled={locked}
              className="rounded bg-zinc-800 py-1 text-zinc-300 hover:bg-zinc-700 disabled:opacity-30"
            >{p.label}</button>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="grid grid-cols-4 gap-1">
        <button onClick={() => layer && dispatch({ type: "xf/flip", id: layer.id, axis: "x" })}
          disabled={locked} title="Flip horizontally"
          className="rounded bg-zinc-700 p-1 hover:bg-zinc-600 disabled:opacity-30"><FlipHorizontal2 size={13} className="mx-auto" /></button>
        <button onClick={() => layer && dispatch({ type: "xf/flip", id: layer.id, axis: "y" })}
          disabled={locked} title="Flip vertically"
          className="rounded bg-zinc-700 p-1 hover:bg-zinc-600 disabled:opacity-30"><FlipVertical2 size={13} className="mx-auto" /></button>
        <button onClick={onCropTool} disabled={disabled} title="Crop"
          className="rounded bg-zinc-700 p-1 hover:bg-zinc-600 disabled:opacity-30"><AlignCenter size={13} className="mx-auto" /></button>
        <button onClick={() => layer && dispatch({ type: "xf/reset", id: layer.id })}
          disabled={locked} title="Reset transform"
          className="rounded bg-zinc-700 p-1 hover:bg-zinc-600 disabled:opacity-30"><RotateCcw size={13} className="mx-auto" /></button>
      </div>
    </div>
  );
}
