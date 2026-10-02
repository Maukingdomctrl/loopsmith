"use client";

/**
 * On-canvas handles, drawn in SVG over the composited canvas.
 *
 * Positions come from the SAME matrices hit-testing uses, so a handle is
 * always exactly where the pointer test expects it. Nothing here computes
 * geometry independently — the moment it did, the visual and the hit area
 * would drift and dragging would feel broken near rotations.
 */

import { useMemo } from "react";
import { overlay } from "@/styles/tokens";
import type { Layer, LayerSelection } from "@/types/layer";
import type { Vec2 } from "@/types/geometry";
import { CANVAS_SIZE } from "@/lib/frameTransform";
import { matApply } from "@/lib/geometry/mat2d";
import { layerContentBox, layerMatrix } from "@/lib/layers/layerSpace";
import { selectedLayers } from "@/lib/layers/selection";
import { rectIsEmpty, rectToQuad } from "@/lib/geometry/rect";
import { vLen, vSub } from "@/lib/geometry/vec2";
import {
  HANDLE_ANCHORS,
  ROTATE_HANDLE_OFFSET,
  type HandleId,
} from "@/lib/geometry/hitTest";
import { HANDLE_RADIUS } from "@/lib/layers/constants";

interface Props {
  layers: readonly Layer[];
  selection: LayerSelection;
  primary: Layer | null;
  activeHandle: HandleId | null;
  visible: boolean;
  straightenLine: { from: Vec2; to: Vec2 } | null;
}

export default function TransformOverlay({
  layers, selection, primary, activeHandle, visible, straightenLine,
}: Props) {
  const geometry = useMemo(() => {
    if (!primary) return null;
    const box = layerContentBox(primary);
    if (rectIsEmpty(box)) return null;

    const m = layerMatrix(primary);
    const quad = rectToQuad(box).map((p) => matApply(m, p)) as Vec2[];

    const handles = (Object.keys(HANDLE_ANCHORS) as (keyof typeof HANDLE_ANCHORS)[]).map((id) => ({
      id: id as HandleId,
      p: matApply(m, {
        x: box.x + box.w * HANDLE_ANCHORS[id].x,
        y: box.y + box.h * HANDLE_ANCHORS[id].y,
      }),
    }));

    const top = matApply(m, { x: box.x + box.w / 2, y: box.y });
    const bottom = matApply(m, { x: box.x + box.w / 2, y: box.y + box.h });
    const up = vSub(top, bottom);
    const len = vLen(up);
    const rotate: Vec2 = len > 1e-4
      ? { x: top.x + (up.x / len) * ROTATE_HANDLE_OFFSET, y: top.y + (up.y / len) * ROTATE_HANDLE_OFFSET }
      : { x: top.x, y: top.y - ROTATE_HANDLE_OFFSET };

    return { quad, handles, rotate, top, pivot: matApply(m, primary.pose.pivot) };
  }, [primary]);

  // Faint outlines for the non-primary members of a multi-selection.
  const secondary = useMemo(
    () =>
      // A selected group outlines every layer inside it.
      selectedLayers(layers, selection)
        .filter((l) => l.id !== primary?.id)
        .map((l) => {
          const box = layerContentBox(l);
          if (rectIsEmpty(box)) return null;
          const m = layerMatrix(l);
          return rectToQuad(box).map((p) => matApply(m, p)) as Vec2[];
        })
        .filter(Boolean) as Vec2[][],
    [layers, selection, primary?.id]
  );

  if (!visible) return null;

  const pts = (q: Vec2[]) => q.map((p) => `${p.x},${p.y}`).join(" ");

  return (
    <svg
      width={CANVAS_SIZE}
      height={CANVAS_SIZE}
      className="pointer-events-none absolute inset-0 z-[60]"
    >
      {secondary.map((q, i) => (
        <polygon key={i} points={pts(q)} fill="none" stroke={overlay.line} strokeWidth={1} strokeDasharray="4 4" opacity={0.6} />
      ))}

      {straightenLine && (
        <>
          <line
            x1={straightenLine.from.x} y1={straightenLine.from.y}
            x2={straightenLine.to.x} y2={straightenLine.to.y}
            stroke={overlay.active} strokeWidth={2} strokeDasharray="6 4"
          />
          <circle cx={straightenLine.from.x} cy={straightenLine.from.y} r={4} fill={overlay.active} />
        </>
      )}

      {geometry && (
        <>
          <polygon points={pts(geometry.quad)} fill="none" stroke={overlay.line} strokeWidth={1.5} />

          <line
            x1={geometry.top.x} y1={geometry.top.y}
            x2={geometry.rotate.x} y2={geometry.rotate.y}
            stroke={overlay.line} strokeWidth={1.5}
          />
          <circle
            cx={geometry.rotate.x} cy={geometry.rotate.y} r={HANDLE_RADIUS}
            fill={activeHandle === "rotate" ? overlay.active : overlay.handleFill}
            stroke={overlay.line} strokeWidth={2}
          />

          {geometry.handles.map((h) => (
            <rect
              key={h.id}
              x={h.p.x - HANDLE_RADIUS} y={h.p.y - HANDLE_RADIUS}
              width={HANDLE_RADIUS * 2} height={HANDLE_RADIUS * 2}
              fill={activeHandle === h.id ? overlay.active : overlay.handle}
              stroke={overlay.line} strokeWidth={1.5} rx={1.5}
            />
          ))}

          {/* Pivot marker: crosshair, so it is legible on top of artwork. */}
          <g opacity={primary?.locked ? 0.4 : 1}>
            <circle
              cx={geometry.pivot.x} cy={geometry.pivot.y} r={HANDLE_RADIUS - 1}
              fill={activeHandle === "pivot" ? overlay.pivot : "none"}
              stroke={overlay.pivot} strokeWidth={2}
            />
            <line x1={geometry.pivot.x - 10} y1={geometry.pivot.y} x2={geometry.pivot.x + 10} y2={geometry.pivot.y} stroke={overlay.pivot} strokeWidth={1} />
            <line x1={geometry.pivot.x} y1={geometry.pivot.y - 10} x2={geometry.pivot.x} y2={geometry.pivot.y + 10} stroke={overlay.pivot} strokeWidth={1} />
          </g>
        </>
      )}
    </svg>
  );
}
