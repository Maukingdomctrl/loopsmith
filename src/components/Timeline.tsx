"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Copy, Eraser, Trash2 } from "lucide-react";
import type { CanvasBackground } from "@/types/layer";

/** Width of one tick (1/fps s) on the timeline, in px. */
const CELL = 28;
/** Width of the dashed "+" button at the end of the track. */
const ADD_W = 36;
/** Longest hold a span can be dragged to, in ticks. */
const MAX_HOLD = 24;

interface TimelineProps {
  frames: (string | null)[];
  /** Hold of each frame, in ticks. */
  durations: number[];
  activeFrame: number;
  /** Where the playhead is: the frame on the canvas (the playing one during playback). */
  currentFrame: number;
  onFrameSelect: (frame: number) => void;
  onReorder: (from: number, to: number) => void;
  /** Hold dragged to a new length. `firstChange` is true once per drag (open one undo step). */
  onHoldChange: (frame: number, hold: number, firstChange: boolean) => void;
  onAddFrame: () => void;
  onImportFrame: (frame: number) => void;
  onDuplicate: () => void;
  onClear: () => void;
  onDeleteFrame: () => void;
  background?: CanvasBackground;
}

export default function Timeline({
  frames,
  durations,
  activeFrame,
  currentFrame,
  onFrameSelect,
  onReorder,
  onHoldChange,
  onAddFrame,
  onImportFrame,
  onDuplicate,
  onClear,
  onDeleteFrame,
  background,
}: TimelineProps) {
  const actionClass =
    "flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white";

  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewWidth, setViewWidth] = useState(0);

  /** First tick of every frame, and the total length in ticks. */
  const { starts, totalTicks } = useMemo(() => {
    const starts: number[] = [];
    let t = 0;
    for (const d of durations) {
      starts.push(t);
      t += Math.max(1, d || 1);
    }
    return { starts, totalTicks: t };
  }, [durations]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The ruler runs at least to the right edge, like empty cells in Animate.
  const rulerTicks = Math.max(totalTicks + 2, Math.ceil(viewWidth / CELL));
  const contentWidth = Math.max(totalTicks * CELL + ADD_W + 8, rulerTicks * CELL);

  const playhead = Math.min(Math.max(0, currentFrame), starts.length - 1);
  const playheadTick = starts[playhead] ?? 0;
  const playheadX = playheadTick * CELL + CELL / 2;

  /** The frame under a tick; past the end means the last frame. */
  const frameAtTick = (tick: number) => {
    for (let i = starts.length - 1; i >= 0; i--) {
      if (tick >= starts[i]) return i;
    }
    return 0;
  };

  // Keep the playhead in view (follows playback, "," and ".").
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const left = playheadTick * CELL;
    if (left < el.scrollLeft || left + CELL > el.scrollLeft + el.clientWidth) {
      el.scrollLeft = Math.max(0, left - CELL * 2);
    }
  }, [playheadTick]);

  /* ---------- scrubbing on the ruler ---------- */

  const scrubbing = useRef(false);
  const scrubTo = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const tick = Math.max(0, Math.floor((e.clientX - rect.left) / CELL));
    const frame = frameAtTick(tick);
    if (frame !== currentFrame) onFrameSelect(frame);
  };

  /* ---------- dragging a span's right edge ---------- */

  const holdDrag = useRef<{ frame: number; x0: number; d0: number; last: number; began: boolean } | null>(null);
  const moveHold = (e: React.PointerEvent) => {
    const drag = holdDrag.current;
    if (!drag) return;
    const hold = Math.min(MAX_HOLD, Math.max(1, drag.d0 + Math.round((e.clientX - drag.x0) / CELL)));
    if (hold === drag.last) return;
    drag.last = hold;
    onHoldChange(drag.frame, hold, !drag.began);
    drag.began = true;
  };

  return (
    <footer className="flex h-28 shrink-0 flex-col border-t border-white/10 bg-[#10131A] px-5 py-2">
      <div className="mb-1 flex h-7 shrink-0 items-center justify-between">
        <p className="text-sm text-zinc-400">
          Timeline ({frames.length} frames) · Frame {currentFrame + 1}
        </p>

        <div className="flex items-center gap-1">
          <button onClick={onDuplicate} className={actionClass} title="Duplicate this frame">
            <Copy size={14} /> Duplicate
          </button>
          <button onClick={onClear} className={actionClass} title="Clear this frame's pixels">
            <Eraser size={14} /> Clear
          </button>
          <button
            onClick={onDeleteFrame}
            className={`${actionClass} hover:bg-red-900/40 hover:text-red-300`}
            title="Delete this frame"
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden [scrollbar-width:thin]"
      >
        <div className="relative" style={{ width: contentWidth }}>
          {/* Ruler: one mark per tick, a number every 5th. Click or drag to scrub. */}
          <div
            className="relative h-4 cursor-ew-resize select-none touch-none"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              scrubbing.current = true;
              scrubTo(e);
            }}
            onPointerMove={(e) => {
              if (scrubbing.current) scrubTo(e);
            }}
            onPointerUp={() => (scrubbing.current = false)}
            onPointerCancel={() => (scrubbing.current = false)}
          >
            <div
              className="absolute inset-x-0 bottom-0 h-1.5"
              style={{
                backgroundImage: `repeating-linear-gradient(to right, rgba(255,255,255,0.18) 0 1px, transparent 1px ${CELL}px)`,
              }}
            />
            {Array.from({ length: rulerTicks }, (_, t) => t + 1)
              .filter((n) => n === 1 || n % 5 === 0)
              .map((n) => (
                <span
                  key={n}
                  className="absolute top-0 text-center text-[10px] leading-3 text-zinc-500"
                  style={{ left: (n - 1) * CELL, width: CELL }}
                >
                  {n}
                </span>
              ))}
          </div>

          <div className="flex h-10 items-stretch">
            {frames.map((image, i) => {
              const hold = Math.max(1, durations[i] || 1);
              const selected = activeFrame === i;
              return (
                <div
                  key={i}
                  role="button"
                  draggable
                  title={`Frame ${i + 1} · hold ${hold}`}
                  onClick={() => onFrameSelect(i)}
                  onDoubleClick={() => {
                    if (!image) onImportFrame(i);
                  }}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", String(i));
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const raw = e.dataTransfer.getData("text/plain");
                    const from = Number(raw);
                    if (raw.trim() === "" || Number.isNaN(from) || from === i) return;
                    onReorder(from, i);
                  }}
                  className={`relative flex flex-shrink-0 cursor-pointer border-y border-r first:border-l ${
                    selected ? "border-indigo-500 bg-indigo-500/25" : "border-zinc-700 bg-zinc-800 hover:bg-zinc-700"
                  }`}
                  style={{ width: hold * CELL }}
                >
                  {/* Keyframe cell: small thumbnail, dot filled when the frame has pixels. */}
                  <div className="flex h-full flex-col items-center justify-between py-1" style={{ width: CELL }}>
                    <div className="h-6 w-6">
                      {image && (
                        <img
                          src={image}
                          alt={`Frame ${i + 1}`}
                          draggable={false}
                          className="h-full w-full object-contain"
                          style={
                            background && !background.transparent
                              ? { background: background.color }
                              : undefined
                          }
                        />
                      )}
                    </div>
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        image ? "bg-zinc-200" : "border border-zinc-400"
                      }`}
                    />
                  </div>

                  {/* Held cells. */}
                  {hold > 1 && (
                    <div
                      className={`h-full flex-1 ${selected ? "bg-indigo-400/15" : "bg-zinc-600/40"}`}
                      style={{
                        backgroundImage: `repeating-linear-gradient(to right, rgba(255,255,255,0.08) 0 1px, transparent 1px ${CELL}px)`,
                      }}
                    />
                  )}

                  {/* Right edge: drag to change the hold. */}
                  <div
                    title="Drag to change the hold"
                    className="absolute inset-y-0 -right-1 z-[5] w-2 cursor-col-resize touch-none hover:bg-indigo-400/40"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      e.currentTarget.setPointerCapture(e.pointerId);
                      holdDrag.current = { frame: i, x0: e.clientX, d0: hold, last: hold, began: false };
                    }}
                    onPointerMove={moveHold}
                    onPointerUp={() => (holdDrag.current = null)}
                    onPointerCancel={() => (holdDrag.current = null)}
                  />
                </div>
              );
            })}

            <button
              onClick={onAddFrame}
              title="Add a blank frame"
              className="ml-2 flex flex-shrink-0 items-center justify-center rounded-md border-2 border-dashed border-zinc-600 text-zinc-400 transition hover:border-indigo-500 hover:text-indigo-400"
              style={{ width: ADD_W }}
            >
              <Plus size={18} />
            </button>
          </div>

          {/* Playhead: red line through the current frame, with its tick number on the ruler. */}
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-red-500"
            style={{ left: playheadX }}
          />
          <div
            className="pointer-events-none absolute top-0 z-10 h-4 -translate-x-1/2 rounded-sm bg-red-500 px-1 text-center text-[10px] font-semibold leading-4 text-white"
            style={{ left: playheadX, minWidth: CELL - 6 }}
          >
            {playheadTick + 1}
          </div>
        </div>
      </div>
    </footer>
  );
}
