"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Repeat } from "lucide-react";
import type { CanvasBackground } from "@/types/layer";
import { checkerStyle } from "@/styles/tokens";

/** Size of a frame tile, in px. */
const TILE = 80;
/** Space between tiles, in px. */
const GAP = 10;
/** Width of one tick (1/fps s) on the timeline: a tile plus its gap. */
const CELL = TILE + GAP;
/** Width of the "Add frame" button at the end of the track. */
const ADD_W = 56;
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
  onDeleteFrame,
  onCopy,
  onPaste,
  background,
}: TimelineProps) {
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

  // Room for the onion bracket past the last frame, and at least the visible width.
  const contentWidth = Math.max(totalTicks * CELL + ADD_W + GAP, (totalTicks + ONION_MAX) * CELL, viewWidth);

  const playhead = Math.min(Math.max(0, currentFrame), starts.length - 1);
  const playheadTick = starts[playhead] ?? 0;

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
    (onionLast < starts.length
      ? (starts[onionLast] + Math.max(1, durations[onionLast] || 1)) * CELL
      : (totalTicks + onionLast - (starts.length - 1)) * CELL) - GAP;

  const moveOnion = (e: React.PointerEvent) => {
    const side = onionDrag.current;
    const ruler = e.currentTarget.parentElement;
    if (!side || !onion || !ruler) return;
    // Brackets snap to the nearest cell edge.
    const edge = Math.round((e.clientX - ruler.getBoundingClientRect().left + (side === "after" ? GAP : 0)) / CELL);
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

  const bgStyle =
    background && !background.transparent ? { background: background.color } : checkerStyle;

  return (
    <footer
      tabIndex={0}
      aria-label="Timeline"
      className="flex h-[168px] shrink-0 flex-col border-t border-line bg-panel px-5 pb-3 pt-2 outline-none"
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
      <div className="mb-2 flex h-9 shrink-0 items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="section-title">Timeline</h2>
          <span className="text-[13px] text-ink-2">
            <span className="font-mono">{frames.length}</span> frame{frames.length === 1 ? "" : "s"}
          </span>
          <button
            onClick={() => onLoopChange(!loop)}
            aria-pressed={loop}
            title={loop ? "Loop is on: plays the selected frames (or all) again and again" : "Loop is off: plays once and stops"}
            className={`flex h-8 items-center gap-1.5 rounded-ctrl px-3 text-[13px] font-semibold ${
              loop ? "selected text-icon-on" : "text-ink-2 hoverable hover:text-ink"
            }`}
          >
            <Repeat size={14} /> Loop
          </button>
        </div>

        <div className="flex items-center gap-1">
          {/* Fixed width, so nothing shifts as the numbers change. */}
          <p
            title="Current frame · time · speed"
            className="ml-3 w-44 whitespace-nowrap text-right font-mono text-[12px] text-ink-2"
          >
            Frame {currentFrame + 1} · {((playheadTick + 1) / fps).toFixed(2)}s · {fps} fps
          </p>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden"
      >
        <div className="relative" style={{ width: contentWidth }}>
          <div
            className="relative flex select-none items-stretch"
            style={{ height: TILE }}
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
                  tabIndex={-1}
                  aria-label={`Frame ${i + 1}, hold ${hold}`}
                  aria-pressed={isSelected}
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
                  className={`relative flex flex-shrink-0 cursor-pointer overflow-hidden rounded-card border bg-ctrl transition-[border-color] duration-150 ${
                    isSelected ? "border-select-strong" : "border-transparent hover:border-line-strong"
                  }`}
                  style={{ width: hold * CELL - GAP, marginRight: GAP }}
                >
                  {/* Keyframe tile: the frame on its document background. */}
                  <div className="h-full shrink-0" style={{ width: TILE - 2, ...bgStyle }}>
                    {image && (
                      <img
                        src={image}
                        alt=""
                        draggable={false}
                        className="h-full w-full object-contain p-1"
                      />
                    )}
                  </div>

                  {/* Held ticks. */}
                  {hold > 1 && (
                    <div
                      className={`h-full flex-1 ${isSelected ? "bg-select" : "bg-ctrl"}`}
                      style={{
                        backgroundImage: `repeating-linear-gradient(to right, var(--color-line) 0 1px, transparent 1px ${CELL}px)`,
                        backgroundPosition: `${GAP}px 0`,
                      }}
                    />
                  )}

                  {/* Right edge: drag to change the hold. */}
                  <div
                    title="Drag to change the hold"
                    className="absolute inset-y-0 right-0 z-[5] w-2 cursor-col-resize touch-none hover:bg-select-line"
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
                style={{ left: (starts[dropSlot] ?? totalTicks) * CELL - GAP / 2 }}
              />
            )}

            <button
              onClick={onAddFrame}
              title="Add a blank frame"
              aria-label="Add frame"
              className="flex flex-shrink-0 items-center justify-center rounded-card bg-ctrl text-icon hoverable hover:text-ink"
              style={{ width: ADD_W }}
            >
              <Plus size={20} />
            </button>
          </div>

          {/* Frame numbers, which double as the scrub bar and carry the onion-skin brackets. */}
          <div
            className="relative mt-1 h-5 cursor-ew-resize select-none touch-none"
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
            {starts.map((start, i) => {
              const isCurrent = i === playhead;
              return (
                <span
                  key={frameIds[i] ?? i}
                  className={`absolute top-0.5 text-center font-mono text-[11px] leading-4 ${
                    isCurrent ? "font-semibold text-accent-hi" : "text-ink-3"
                  }`}
                  style={{ left: start * CELL, width: TILE }}
                >
                  {i + 1}
                </span>
              );
            })}

            {/* Onion-skin markers: drag the brackets to show more or fewer frames. */}
            {onion && (
              <>
                <div
                  className="pointer-events-none absolute inset-y-0 rounded-[4px] bg-hover"
                  style={{ left: onionLeft, width: onionRight - onionLeft }}
                />
                <div
                  onPointerDown={(e) => startOnion(e, "before")}
                  onPointerMove={moveOnion}
                  onPointerUp={() => (onionDrag.current = null)}
                  onPointerCancel={() => (onionDrag.current = null)}
                  title={`Onion skin: ${onion.before} before (drag)`}
                  aria-label={`Onion skin: ${onion.before} frames before`}
                  className="absolute inset-y-0 z-20 w-1.5 cursor-col-resize rounded-l-sm border-y-2 border-l-2 border-danger"
                  style={{ left: onionLeft - 6 }}
                />
                <div
                  onPointerDown={(e) => startOnion(e, "after")}
                  onPointerMove={moveOnion}
                  onPointerUp={() => (onionDrag.current = null)}
                  onPointerCancel={() => (onionDrag.current = null)}
                  title={`Onion skin: ${onion.after} after (drag)`}
                  aria-label={`Onion skin: ${onion.after} frames after`}
                  className="absolute inset-y-0 z-20 w-1.5 cursor-col-resize rounded-r-sm border-y-2 border-r-2 border-success"
                  style={{ left: onionRight }}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </footer>
  );
}
