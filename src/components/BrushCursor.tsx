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
 *
 * The SVG is anchored at the tip and placed with a CSS translate, so the
 * canvas can move it on every pointer sample by writing `cursorTransform`
 * to the element (see Canvas) instead of re-rendering the editor. The same
 * goes for the pencil's tip following pen pressure: `sizeCursorTip` rewrites
 * the few attributes that depend on the radius, in place.
 */

import { useMemo, type Ref } from "react";
import { cursorArt } from "@/styles/tokens";
import type { Vec2 } from "@/types/geometry";
import type { BrushCursorShape } from "@/types/raster";

/** The CSS transform that puts the cursor's tip at a canvas-space point. */
export const cursorTransform = (p: Vec2): string => `translate(${p.x}px, ${p.y}px)`;

/**
 * The pencil's size-dependent parts. The tool grows with the tip: the lead
 * ends in a rounded tip exactly as wide as the mark it leaves, and the pencil
 * scales with it (up to 4×) so it still looks like a pencil in the hand.
 */
function pencilArt(r: number) {
  const s = Math.min(4, Math.max(1, r));
  return {
    lead: `scale(${s})`,
    leadStroke: 0.75 / s,
    tip: `M ${4 * s} ${-1.3 * s} L 0 ${-r} A ${r} ${r} 0 0 0 0 ${r} L ${4 * s} ${1.3 * s} Z`,
  };
}

/** The rubber's size-dependent parts: its rubbing end is as wide as the eraser. */
function rubberArt(r: number) {
  const h = Math.max(5, r);
  const k = Math.min(3, Math.max(1, r / 5));
  return { y: -h, height: 2 * h, end: 12 * k, endRound: 2 * k, sleeve: 16 * k, sleeveRound: k };
}

/**
 * Resize a rendered pencil or rubber cursor to `radius` (canvas px) in place —
 * for following pen pressure without re-rendering the editor every frame.
 */
export function sizeCursorTip(svg: SVGSVGElement | null, radius: number): void {
  if (!svg) return;
  const r = Math.max(0.5, radius);
  const tip = svg.querySelector<SVGPathElement>("[data-tip]");
  const lead = svg.querySelector<SVGGElement>("[data-lead]");
  if (tip && lead) {
    const art = pencilArt(r);
    lead.setAttribute("transform", art.lead);
    lead.setAttribute("stroke-width", String(art.leadStroke));
    tip.setAttribute("d", art.tip);
  }
  const end = svg.querySelector<SVGRectElement>("[data-rubber]");
  const sleeve = svg.querySelector<SVGRectElement>("[data-sleeve]");
  if (end && sleeve) {
    const a = rubberArt(r);
    for (const el of [end, sleeve]) {
      el.setAttribute("y", String(a.y));
      el.setAttribute("height", String(a.height));
    }
    end.setAttribute("width", String(a.end));
    end.setAttribute("rx", String(a.endRound));
    sleeve.setAttribute("x", String(a.end));
    sleeve.setAttribute("width", String(a.sleeve));
    sleeve.setAttribute("rx", String(a.sleeveRound));
  }
}

interface Props {
  /** The cursor's element, for moving it without a render. */
  ref?: Ref<SVGSVGElement>;
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
  /** Pencil lead colour — the current paint colour. */
  color?: string;
  visible?: boolean;
}


export default function BrushCursor({
  ref,
  position,
  radius,
  angle = 0,
  aspect = 1,
  erasing = false,
  color = "#000000",
  visible = true,
}: Props) {
  const geometry = useMemo(() => {
    if (!position) return null;
    const rx = Math.max(0.5, radius * Math.max(0.01, aspect));
    const ry = Math.max(0.5, radius);
    return { rx, ry };
  }, [position, radius, aspect]);

  if (!visible || !position || !geometry) return null;

  const { rx, ry } = geometry;
  const shadow = cursorArt.outline;

  const r = Math.max(rx, ry);
  const art = pencilArt(r);
  const rub = rubberArt(r);

  return (
    <svg
      ref={ref}
      width={1}
      height={1}
      overflow="visible"
      className="pointer-events-none absolute left-0 top-0 z-[90]"
      style={{ transform: cursorTransform(position) }}
      aria-hidden
    >
      <g transform={`rotate(${angle})`}>
        {/* Held at 45°, with the tip exactly on the pointer. */}
        <g transform="rotate(-45)" stroke={shadow} strokeWidth={0.75} strokeLinejoin="round">
          {erasing ? (
            <>
              <rect data-rubber x={0} y={rub.y} width={rub.end} height={rub.height} rx={rub.endRound} fill={cursorArt.rubber} />
              <rect data-sleeve x={rub.end} y={rub.y} width={rub.sleeve} height={rub.height} rx={rub.sleeveRound} fill={cursorArt.sleeve} />
            </>
          ) : (
            <>
              <g data-lead transform={art.lead} strokeWidth={art.leadStroke}>
                <polygon points="4,-1.3 11,-3.5 11,3.5 4,1.3" fill={cursorArt.wood} />
                <rect x={11} y={-3.5} width={20} height={7} fill={cursorArt.body} />
                <rect x={31} y={-3.5} width={3.5} height={7} fill={cursorArt.ferrule} />
                <rect x={34.5} y={-3.5} width={4.5} height={7} rx={1.5} fill={cursorArt.eraser} />
              </g>
              <path data-tip d={art.tip} fill={color} />
            </>
          )}
        </g>
      </g>
    </svg>
  );
}
