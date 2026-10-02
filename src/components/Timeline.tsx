"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Copy, Eraser, Trash2, Repeat } from "lucide-react";
import type { CanvasBackground } from "@/types/layer";

/** Width of one tick (1/fps s) on the timeline, in px. */
const CELL = 28;
/** Width of the dashed "+" button at the end of the track. */
const ADD_W = 36;
/** Longest hold a frame can have, in ticks. */
export const MAX_HOLD = 24;
/** Most frames the onion skin can show on each side. */
const ONION_MAX = 5;

interface TimelineProps {
  frames: (string | null)[];
  /** Hold of each frame, in ticks. */
  durations: number[];
  /** Id of each frame, so the selection survives reordering. */
  frameIds: string[];
  /** Selected frames (highlighted; what Delete, copy and dragging act on). */
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  /** Onion-skin frames before / after the current one; undefined while onion skin is off. */
  onion?: { before: number; after: number };
  onOnionChange: (onion: { before: number; after: number }) => void;
  fps: number;
  loop: boolean;
  onLoopChange: (loop: boolean) => void;
  activeFrame: number;
  /** Where the playhead is: the frame on the canvas (the playing one during playback). */
  currentFrame: number;
  onFrameSelect: (frame: number) => void;
  /** Move frame `from` (with the rest of the selection, if it is selected) to insertion slot `to`. */
  onReorder: (from: number, to: number) => void;
  /** Hold dragged to a new length. `firstChange` is true once per drag (open one undo step). */
  onHoldChange: (frame: number, hold: number, firstChange: boolean) => void;
  onAddFrame: () => void;
  onImportFrame: (frame: number) => void;
  onDuplicate: () => void;
  onClear: () => void;
  onDeleteFrame: () => void;
  onCopy: () => void;
  onPaste: () => void;
  background?: CanvasBackground;
}

export default function Timeline({
  frames,
  durations,
  frameIds,
  selectedIds,
  onSelectionChange,
  onion,
  onOnionChange,
  fps,
  loop,
  onLoopChange,
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
  onCopy,
  onPaste,
  background,
}: TimelineProps) {
  const actionClass =
    "flex h-7 items-center gap-1.5 rounded-ctrl px-2 text-xs text-ink hoverable hover:text-ink";

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
  const rulerTicks = Math.max(totalTicks + ONION_MAX + 1, Math.ceil(viewWidth / CELL));
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

  /* ---------- onion-skin markers on the ruler ---------- */

  const onionDrag = useRef<"before" | "after" | null>(null);
  const onionFirst = Math.max(0, playhead - (onion?.before ?? 0));
  const onionLast = playhead + (onion?.after ?? 0);
  const onionLeft = starts[onionFirst] * CELL;
  // Past the last frame the marker runs on into the empty ruler cells, one per frame.
  const onionRight =
    onionLast < starts.length
      ? (starts[onionLast] + Math.max(1, durations[onionLast] || 1)) * CELL
      : (totalTicks + onionLast - (starts.length - 1)) * CELL;

  const moveOnion = (e: React.PointerEvent) => {
    const side = onionDrag.current;
    const ruler = e.currentTarget.parentElement;
    if (!side || !onion || !ruler) return;
    // Brackets snap to the nearest cell edge.
    const edge = Math.round((e.clientX - ruler.getBoundingClientRect().left) / CELL);
    const count =
      side === "before"
        ? playhead - frameAtTick(Math.max(0, edge))
        : (edge > totalTicks ? starts.length - 1 + edge - totalTicks : frameAtTick(Math.max(0, edge - 1))) - playhead;
    const next = Math.min(ONION_MAX, Math.max(0, count));
    if (next !== onion[side]) onOnionChange({ ...onion, [side]: next });
  };

  const startOnion = (e: React.PointerEvent<HTMLDivElement>, side: "before" | "after") => {
    if (e.button !== 0) return;
    e.stopPropagation(); // not a scrub
    e.currentTarget.setPointerCapture(e.pointerId);
    onionDrag.current = side;
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

  /* ---------- selecting and moving frames ---------- */

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  /** Where a Shift-click range starts: the last plain or Ctrl-click. */
  const anchorId = useRef<string | null>(null);

  const clickFrame = (e: React.MouseEvent, i: number) => {
    const id = frameIds[i];
    if (e.shiftKey) {
      const anchor = frameIds.indexOf(anchorId.current ?? "");
      const from = anchor >= 0 ? anchor : activeFrame;
      const [lo, hi] = from < i ? [from, i] : [i, from];
      onFrameSelect(i);
      onSelectionChange(frameIds.slice(lo, hi + 1));
    } else if (e.ctrlKey || e.metaKey) {
      anchorId.current = id;
      if (selected.has(id)) {
        onSelectionChange(selectedIds.filter((s) => s !== id));
      } else {
        onFrameSelect(i);
        onSelectionChange([...selectedIds, id]);
      }
    } else {
      anchorId.current = id;
      onFrameSelect(i);
      onSelectionChange([id]);
    }
  };

  /** Drop slot under the pointer: before a frame on its left half, after it on its right half. */
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  const slotAt = (e: React.DragEvent<HTMLDivElement>) => {
    const x = (e.clientX - e.currentTarget.getBoundingClientRect().left) / CELL;
    for (let i = 0; i < starts.length; i++) {
      if (x < starts[i] + Math.max(1, durations[i] || 1) / 2) return i;
    }
    return starts.length;
  };

  return (
    <footer
      tabIndex={0}
      className="flex h-28 shrink-0 flex-col border-t border-line bg-panel px-5 py-2 outline-none"
      onKeyDown={(e) => {
        // Only while the timeline has focus, so the canvas's own Delete is untouched.
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          e.stopPropagation();
          if (frames.length > 1) onDeleteFrame();
        } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
          const key = e.key.toLowerCase();
          if (key === "c") onCopy();
          else if (key === "v") onPaste();
          else return;
          e.preventDefault();
        }
      }}
    >
      <div className="mb-1 flex h-7 shrink-0 items-center justify-between">
        <div className="flex items-center gap-2">
          <p className="text-sm text-ink-2">Timeline ({frames.length} frames)</p>
          <button
            onClick={() => onLoopChange(!loop)}
            aria-pressed={loop}
            title={loop ? "Loop is on: plays the selected frames (or all) again and again" : "Loop is off: plays once and stops"}
            className={`flex h-7 items-center gap-1.5 rounded-ctrl px-2 text-xs ${
              loop ? "selected text-icon-on" : "text-ink-3 hoverable hover:text-ink"
            }`}
          >
            <Repeat size={14} /> Loop
          </button>
        </div>

        <div className="flex items-center gap-1">
          <button onClick={onDuplicate} className={actionClass} title="Duplicate this frame">
            <Copy size={14} /> Duplicate
          </button>
          <button onClick={onClear} className={actionClass} title="Clear this frame's pixels">
            <Eraser size={14} /> Clear
          </button>
          <button
            onClick={onDeleteFrame}
            className={`${actionClass} hover:bg-danger-bg hover:text-danger-strong`}
            title="Delete the selected frames"
          >
            <Trash2 size={14} /> Delete
          </button>
          {/* Fixed width, so nothing shifts as the numbers change. */}
          <p
            title="Current frame · time · speed"
            className="ml-3 w-44 whitespace-nowrap text-right text-xs font-mono text-ink-2"
          >
            Frame {currentFrame + 1} · {((playheadTick + 1) / fps).toFixed(2)}s · {fps} fps
          </p>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden pl-2 [scrollbar-width:thin]"
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
                backgroundImage: `repeating-linear-gradient(to right, var(--color-line-strong) 0 1px, transparent 1px ${CELL}px)`,
              }}
            />
            {Array.from({ length: rulerTicks }, (_, t) => t + 1)
              .filter((n) => n === 1 || n % 5 === 0)
              .map((n) => (
                <span
                  key={n}
                  className="absolute top-0 text-center text-[11px] leading-3 text-ink-3"
                  style={{ left: (n - 1) * CELL, width: CELL }}
                >
                  {n}
                </span>
              ))}

            {/* Onion-skin markers: drag the brackets to show more or fewer frames. */}
            {onion && (
              <>
                <div
                  className="pointer-events-none absolute inset-y-0 bg-hover"
                  style={{ left: onionLeft, width: onionRight - onionLeft }}
                />
                <div
                  onPointerDown={(e) => startOnion(e, "before")}
                  onPointerMove={moveOnion}
                  onPointerUp={() => (onionDrag.current = null)}
                  onPointerCancel={() => (onionDrag.current = null)}
                  title={`Onion skin: ${onion.before} before (drag)`}
                  className="absolute inset-y-0 z-20 w-1.5 cursor-col-resize rounded-l-sm border-y-2 border-l-2 border-danger"
                  style={{ left: onionLeft - 6 }}
                />
                <div
                  onPointerDown={(e) => startOnion(e, "after")}
                  onPointerMove={moveOnion}
                  onPointerUp={() => (onionDrag.current = null)}
                  onPointerCancel={() => (onionDrag.current = null)}
                  title={`Onion skin: ${onion.after} after (drag)`}
                  className="absolute inset-y-0 z-20 w-1.5 cursor-col-resize rounded-r-sm border-y-2 border-r-2 border-success"
                  style={{ left: onionRight }}
                />
              </>
            )}
          </div>

          <div
            className="relative flex h-10 select-none items-stretch"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const slot = slotAt(e);
              if (slot !== dropSlot) setDropSlot(slot);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropSlot(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDropSlot(null);
              const raw = e.dataTransfer.getData("text/plain");
              const from = Number(raw);
              if (raw.trim() === "" || Number.isNaN(from)) return;
              onReorder(from, slotAt(e));
            }}
          >
            {frames.map((image, i) => {
              const hold = Math.max(1, durations[i] || 1);
              const isSelected = selected.has(frameIds[i]);
              return (
                <div
                  key={frameIds[i] ?? i}
                  role="button"
                  draggable
                  title={`Frame ${i + 1} · hold ${hold}`}
                  onClick={(e) => clickFrame(e, i)}
                  onDoubleClick={() => {
                    if (!image) onImportFrame(i);
                  }}
                  onDragStart={(e) => {
                    // Dragging an unselected frame moves just that frame.
                    if (!isSelected) {
                      anchorId.current = frameIds[i];
                      onFrameSelect(i);
                      onSelectionChange([frameIds[i]]);
                    }
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", String(i));
                  }}
                  onDragEnd={() => setDropSlot(null)}
                  className={`relative flex flex-shrink-0 cursor-pointer border-y border-r first:border-l ${
                    isSelected ? "border-select-line selected" : "border-line bg-ctrl hoverable"
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
                        image ? "bg-ink" : "border border-line-strong"
                      }`}
                    />
                  </div>

                  {/* Held cells. */}
                  {hold > 1 && (
                    <div
                      className={`h-full flex-1 ${isSelected ? "bg-select" : "bg-ctrl-hi"}`}
                      style={{
                        backgroundImage: `repeating-linear-gradient(to right, var(--color-hover) 0 1px, transparent 1px ${CELL}px)`,
                      }}
                    />
                  )}

                  {/* Right edge: drag to change the hold. */}
                  <div
                    title="Drag to change the hold"
                    className="absolute inset-y-0 -right-1 z-[5] w-2 cursor-col-resize touch-none hover:bg-select-line"
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

            {/* Where a dragged block will land. */}
            {dropSlot !== null && (
              <div
                className="pointer-events-none absolute inset-y-0 z-20 w-0.5 -translate-x-1/2 bg-accent"
                style={{ left: (starts[dropSlot] ?? totalTicks) * CELL }}
              />
            )}

            <button
              onClick={onAddFrame}
              title="Add a blank frame"
              className="ml-2 flex flex-shrink-0 items-center justify-center rounded-ctrl border-2 border-dashed border-line-strong text-ink-2 transition hover:border-select-line hover:text-accent-hi"
              style={{ width: ADD_W }}
            >
              <Plus size={18} />
            </button>
          </div>

          {/* Playhead: red line through the current frame, with its tick number on the ruler. */}
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-primary"
            style={{ left: playheadX }}
          />
          <div
            className="pointer-events-none absolute top-0 z-10 h-4 -translate-x-1/2 rounded-sm bg-primary px-1 text-center text-[11px] font-semibold leading-4 text-ink"
            style={{ left: playheadX, minWidth: CELL - 6 }}
          >
            {playheadTick + 1}
          </div>
        </div>
      </div>
    </footer>
  );
}
