"use client";

/**
 * Crop UI. Dims everything outside the rect using an even-odd fill rather than
 * four separate rectangles, so there is no seam artifact at the corners.
 */

import { Check, X } from "lucide-react";
import { overlay } from "@/styles/tokens";
import type { DocumentCropDraft } from "@/lib/layers/crop";
import { CANVAS_SIZE } from "@/lib/frameTransform";
import { HANDLE_ANCHORS, type HandleId } from "@/lib/geometry/hitTest";
import { HANDLE_RADIUS } from "@/lib/layers/constants";

interface Props {
  draft: DocumentCropDraft | null;
  activeHandle: HandleId | null;
  onAspect: (a: number | null) => void;
  onCommit: (refit: boolean) => void;
  onCancel: () => void;
}

const ASPECTS: { label: string; value: number | null }[] = [
  { label: "Free", value: null },
  { label: "1:1", value: 1 },
  { label: "4:3", value: 4 / 3 },
  { label: "16:9", value: 16 / 9 },
  { label: "3:4", value: 3 / 4 },
];

export default function CropOverlay({ draft, activeHandle, onAspect, onCommit, onCancel }: Props) {
  if (!draft) return null;
  const r = draft.rect;

  return (
    <>
      <svg width={CANVAS_SIZE} height={CANVAS_SIZE} className="pointer-events-none absolute inset-0 z-[70]">
        <path
          d={`M0,0 H${CANVAS_SIZE} V${CANVAS_SIZE} H0 Z M${r.x},${r.y} H${r.x + r.w} V${r.y + r.h} H${r.x} Z`}
          fill={overlay.scrim} fillRule="evenodd"
        />
        <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke={overlay.line} strokeWidth={1.5} />

        {/* Rule-of-thirds guides. */}
        {[1, 2].map((i) => (
          <g key={i} stroke={overlay.line} strokeWidth={0.5} opacity={0.5}>
            <line x1={r.x + (r.w * i) / 3} y1={r.y} x2={r.x + (r.w * i) / 3} y2={r.y + r.h} />
            <line x1={r.x} y1={r.y + (r.h * i) / 3} x2={r.x + r.w} y2={r.y + (r.h * i) / 3} />
          </g>
        ))}

        {(Object.keys(HANDLE_ANCHORS) as (keyof typeof HANDLE_ANCHORS)[]).map((id) => {
          const a = HANDLE_ANCHORS[id];
          const cx = r.x + r.w * a.x;
          const cy = r.y + r.h * a.y;
          return (
            <rect
              key={id}
              x={cx - HANDLE_RADIUS} y={cy - HANDLE_RADIUS}
              width={HANDLE_RADIUS * 2} height={HANDLE_RADIUS * 2}
              fill={activeHandle === id ? overlay.active : overlay.handle}
              stroke={overlay.line} strokeWidth={1.5}
            />
          );
        })}
      </svg>

      <div className="absolute bottom-3 left-1/2 z-[80] flex -translate-x-1/2 items-center gap-2 rounded-panel bg-panel p-2">
        <div className="flex gap-1">
          {ASPECTS.map((a) => (
            <button
              key={a.label}
              onClick={() => onAspect(a.value)}
              className={`rounded-ctrl px-2 py-1 text-[11px] ${
                draft.aspect === a.value ? "selected text-icon-on" : "bg-ctrl text-ink hoverable"
              }`}
            >{a.label}</button>
          ))}
        </div>
        <span className="px-1 text-[11px] text-ink-2">
          {Math.round(r.w)} × {Math.round(r.h)}
        </span>
        <button onClick={() => onCommit(true)} title="Apply crop (Enter)"
          className="flex h-8 w-8 items-center justify-center rounded-ctrl bg-primary text-on-primary hoverable"><Check size={15} /></button>
        <button onClick={onCancel} title="Cancel (Esc)"
          className="flex h-8 w-8 items-center justify-center rounded-ctrl border border-danger-line bg-danger-bg text-danger-strong hoverable"><X size={15} /></button>
      </div>
    </>
  );
}
