"use client";

/**
 * Brush cursor — the only React file in the raster subsystem.
 *
 * Renders in CANVAS space, so the ring's radius is the brush's local radius
 * pushed through the layer's scale. That is what makes the cursor tell the
 * truth on a scaled layer: a 10 px brush on a layer scaled 4× must show a
 * 40 px ring, because that is the size of the mark it will leave.
 *
 * Pointer-events are disabled throughout. A cursor that can be clicked would
 * swallow the very events the tools need.
 */

import { useMemo } from "react";
import type { Vec2 } from "@/types/geometry";
import type { BrushCursorShape } from "@/types/raster";
import { CANVAS_SIZE } from "@/lib/frameTransform";

interface Props {
  /** Canvas-space centre. null hides the cursor. */
  position: Vec2 | null;
  /** Radius in CANVAS px — already converted via localRadiusToCanvas. */
  radius: number;
  shape?: BrushCursorShape;
  /** Stamp rotation in degrees, for chisel/square brushes. */
  angle?: number;
  /** Aspect ratio w/h. */
  aspect?: number;
  /** Eraser cursors are drawn differently so the tool is unmistakable. */
  erasing?: boolean;
  /** Live pressure, 0..1, drawn as an inner ring. */
  pressure?: number;
  visible?: boolean;
}

/** Below this the ring is illegible, so a crosshair is drawn instead. */
const MIN_RING_RADIUS = 3;
/** Above this a centre dot is added, since the ring's centre is far from it. */
const CENTER_DOT_RADIUS = 14;

export default function BrushCursor({
  position,
  radius,
  shape = "round",
  angle = 0,
  aspect = 1,
  erasing = false,
  pressure,
  visible = true,
}: Props) {
  const geometry = useMemo(() => {
    if (!position) return null;
    const rx = Math.max(0.5, radius * Math.max(0.01, aspect));
    const ry = Math.max(0.5, radius);
    return { rx, ry, tooSmall: Math.max(rx, ry) < MIN_RING_RADIUS };
  }, [position, radius, aspect]);

  if (!visible || !position || !geometry) return null;

  const { rx, ry, tooSmall } = geometry;
  const stroke = erasing ? "#F87171" : "#FFFFFF";
  // Two concentric strokes — dark under light — so the cursor stays visible on
  // both white and black artwork without any blend-mode trickery.
  const shadow = "rgba(0,0,0,0.75)";

  return (
    <svg
      width={CANVAS_SIZE}
      height={CANVAS_SIZE}
      className="pointer-events-none absolute inset-0 z-[90]"
      aria-hidden
    >
      <g transform={`translate(${position.x} ${position.y}) rotate(${angle})`}>
        {tooSmall || shape === "crosshair" || shape === "precise" ? (
          <>
            <g stroke={shadow} strokeWidth={3}>
              <line x1={-8} y1={0} x2={-2} y2={0} />
              <line x1={2} y1={0} x2={8} y2={0} />
              <line x1={0} y1={-8} x2={0} y2={-2} />
              <line x1={0} y1={2} x2={0} y2={8} />
            </g>
            <g stroke={stroke} strokeWidth={1}>
              <line x1={-8} y1={0} x2={-2} y2={0} />
              <line x1={2} y1={0} x2={8} y2={0} />
              <line x1={0} y1={-8} x2={0} y2={-2} />
              <line x1={0} y1={2} x2={0} y2={8} />
            </g>
          </>
        ) : shape === "square" ? (
          <>
            <rect x={-rx} y={-ry} width={rx * 2} height={ry * 2} fill="none" stroke={shadow} strokeWidth={3} />
            <rect x={-rx} y={-ry} width={rx * 2} height={ry * 2} fill="none" stroke={stroke} strokeWidth={1} />
          </>
        ) : (
          <>
            <ellipse cx={0} cy={0} rx={rx} ry={ry} fill="none" stroke={shadow} strokeWidth={3} />
            <ellipse
              cx={0} cy={0} rx={rx} ry={ry}
              fill="none" stroke={stroke} strokeWidth={1}
              strokeDasharray={erasing ? "4 3" : undefined}
            />
          </>
        )}

        {/* Pressure feedback: inner ring at the radius the stamp will actually use. */}
        {pressure !== undefined && pressure > 0 && pressure < 1 && !tooSmall && (
          <ellipse
            cx={0} cy={0}
            rx={Math.max(0.5, rx * pressure)} ry={Math.max(0.5, ry * pressure)}
            fill="none" stroke={erasing ? "#F87171" : "#22D3EE"}
            strokeWidth={1} opacity={0.8}
          />
        )}

        {Math.max(rx, ry) > CENTER_DOT_RADIUS && (
          <>
            <circle cx={0} cy={0} r={1.6} fill={shadow} />
            <circle cx={0} cy={0} r={0.8} fill={stroke} />
          </>
        )}
      </g>
    </svg>
  );
}
