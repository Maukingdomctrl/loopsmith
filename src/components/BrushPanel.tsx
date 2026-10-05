"use client";

/**
 * The brush panel.
 *
 * Every picture in it is drawn by the brush engine itself (see
 * lib/raster/brushes/preview.ts): the shape is a real tap, the stroke a real
 * curved stroke, and the pressure preview a real 0→1 pressure ramp. So the panel
 * is a truthful sample of each brush in the current colour, not an icon set.
 *
 * Rows show every brush at once so they can be compared by eye; the
 * settings of the selected one sit underneath.
 */

import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { BRUSHES, formatSize, sizeStep } from "@/lib/raster/brushes/presets";
import {
  previewBackground,
  renderBrushPreview,
  type PreviewKind,
} from "@/lib/raster/brushes/preview";
import {
  BRUSH_MODES,
  type BrushId,
  type BrushPrefs,
  type BrushSpec,
} from "@/lib/raster/brushes/types";
import { BLEND_LABELS, type BlendMode } from "@/types/layer";
import { parseHex } from "@/lib/raster/color";
import { rangeFill } from "@/styles/tokens";

/** Preview pixel density: drawn at 2× and shown at 1× so it stays crisp. */
const DENSITY = 2;

const PREVIEW_SIZE: Record<PreviewKind, { w: number; h: number }> = {
  tip: { w: 36, h: 36 },
  stroke: { w: 104, h: 26 },
  pressure: { w: 62, h: 26 },
};

const PREVIEW_TITLE: Record<PreviewKind, string> = {
  tip: "Shape",
  stroke: "Brush",
  pressure: "Pressure response, light to firm",
};

/* Previews are pure functions of (brush, material, colour): render each once.
 * Bounded, oldest first, so dragging through the colour wheel cannot grow it
 * without limit. */
const previewCache = new Map<string, ImageData>();
const PREVIEW_CACHE_LIMIT = 150;

/** A value that only follows `value` once it has held still for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return settled;
}

function usePreview(
  spec: BrushSpec,
  kind: PreviewKind,
  material: string | undefined,
  colorHex: string,
  angle: number
): ImageData | null {
  // only the rectangle's shape depends on its angle
  const key = `${spec.id}|${kind}|${material ?? ""}|${colorHex}|${
    spec.id === "softRect" && kind === "tip" ? angle : 0
  }`;
  // The cache is a pure function of the key, so it can be read during render;
  // `redraw` only exists to wake the component when a preview lands.
  const [, redraw] = useState(0);

  useEffect(() => {
    if (previewCache.has(key)) return;
    // Yield first: opening the panel must never cost a frame, and the previews
    // (a water stroke is a small simulation) render one task at a time.
    const id = window.setTimeout(() => {
      const rgb = parseHex(colorHex) ?? { r: 0.1, g: 0.1, b: 0.12, a: 1 };
      const { w, h } = PREVIEW_SIZE[kind];
      const px = renderBrushPreview({
        brush: spec,
        kind,
        width: w,
        height: h,
        color: rgb,
        material,
        angle,
        background: previewBackground(rgb),
        scale: DENSITY,
      });
      if (previewCache.size >= PREVIEW_CACHE_LIMIT) {
        const oldest = previewCache.keys().next().value;
        if (oldest !== undefined) previewCache.delete(oldest);
      }
      previewCache.set(key, new ImageData(px, w * DENSITY, h * DENSITY));
      redraw((n) => n + 1);
    }, 0);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return previewCache.get(key) ?? null;
}

function PreviewCanvas({
  spec, kind, material, colorHex, angle,
}: {
  spec: BrushSpec;
  kind: PreviewKind;
  material: string | undefined;
  colorHex: string;
  angle: number;
}) {
  const data = usePreview(spec, kind, material, colorHex, angle);
  const ref = useRef<HTMLCanvasElement>(null);
  const { w, h } = PREVIEW_SIZE[kind];

  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (ctx && data) ctx.putImageData(data, 0, 0);
  }, [data]);

  return (
    <canvas
      ref={ref}
      width={w * DENSITY}
      height={h * DENSITY}
      style={{ width: w, height: h }}
      title={PREVIEW_TITLE[kind]}
      aria-label={`${spec.name}: ${PREVIEW_TITLE[kind].toLowerCase()}`}
      className={`shrink-0 rounded-ctrl bg-ink ${data ? "" : "opacity-40"}`}
    />
  );
}

function Slider({
  label, value, min, max, step, format, onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="w-[58px] shrink-0 text-ink">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1 "
        style={rangeFill(value, min, max)}
      />
      <span className="w-10 shrink-0 text-right font-mono text-ink">
        {format(value)}
      </span>
    </label>
  );
}

interface Props {
  brushId: BrushId;
  prefs: Record<BrushId, BrushPrefs>;
  /** Current paint colour, "#rrggbb". */
  color: string;
  onSelect: (id: BrushId) => void;
  onChange: (id: BrushId, patch: Partial<BrushPrefs>) => void;
  onClose: () => void;
}

export default function BrushPanel({
  brushId, prefs, color, onSelect, onChange, onClose,
}: Props) {
  const spec = BRUSHES.find((b) => b.id === brushId) ?? BRUSHES[0];
  const p = prefs[spec.id];
  // the native colour picker fires continuously while it is dragged; the
  // previews wait for it to settle instead of rendering every step
  const previewColor = useDebounced(color, 250);

  return (
    <div
      role="dialog"
      aria-label="Brushes"
      className="w-[268px] max-h-full overflow-y-auto rounded-panel border border-line bg-panel text-ink shadow-flyout backdrop-blur"
    >
      <div className="flex items-center justify-between px-3 pt-2.5">
        <h2 className="section-title">
          Brushes
        </h2>
        <button
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close brush panel"
          className="flex h-6 w-6 items-center justify-center rounded-ctrl text-ink-2 hover:bg-hover hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>

      <div role="radiogroup" aria-label="Brush" className="flex flex-col gap-1 p-1.5">
        {BRUSHES.map((b) => {
          const selected = b.id === brushId;
          const bp = prefs[b.id];
          return (
            <button
              key={b.id}
              role="radio"
              aria-checked={selected}
              onClick={() => onSelect(b.id)}
              className={`flex items-center gap-2 rounded-ctrl px-2 py-1.5 text-left transition ${
                selected
                  ? "selected"
                  : "hover:bg-hover"
              }`}
            >
              <PreviewCanvas
                spec={b} kind="tip" material={bp.material} colorHex={previewColor} angle={bp.angle}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between">
                  <span className="truncate text-[13px] font-medium">{b.name}</span>
                  {selected && <Check size={13} className="shrink-0 text-icon-on" />}
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <PreviewCanvas
                    spec={b} kind="stroke" material={bp.material} colorHex={previewColor} angle={0}
                  />
                  <PreviewCanvas
                    spec={b} kind="pressure" material={bp.material} colorHex={previewColor} angle={0}
                  />
                </div>
              </div>
            </button>
          );
        })}
      </div>

      <div className="space-y-2.5 border-t border-line px-3 pb-3 pt-2.5">
        <p className="text-[11px] leading-snug text-ink-2">{spec.tagline}</p>

        <Slider
          label="Size"
          value={p.size}
          min={spec.minSize}
          max={spec.maxSize}
          step={sizeStep(spec)}
          format={formatSize}
          onChange={(v) => onChange(spec.id, { size: v })}
        />
        <Slider
          label={spec.intensityLabel}
          value={Math.round(p.intensity * 100)}
          min={5}
          max={100}
          step={1}
          format={(v) => `${v}%`}
          onChange={(v) => onChange(spec.id, { intensity: v / 100 })}
        />
        {!spec.erase && (
          <label className="flex items-center gap-2 text-xs">
            <span className="w-[58px] shrink-0 text-ink">Mode</span>
            <select
              value={p.mode ?? "normal"}
              onChange={(e) => onChange(spec.id, { mode: e.target.value as BlendMode })}
              className="min-w-0 flex-1 rounded-ctrl bg-ctrl px-1 py-1 text-xs text-ink outline-none"
            >
              {BRUSH_MODES.map((m) => (
                <option key={m} value={m}>{BLEND_LABELS[m]}</option>
              ))}
            </select>
          </label>
        )}
        {spec.hasAngle && (
          <Slider
            label="Angle"
            value={p.angle}
            min={0}
            max={180}
            step={1}
            format={(v) => `${v}°`}
            onChange={(v) => onChange(spec.id, { angle: v })}
          />
        )}

        {spec.materials && (
          <div
            role="radiogroup"
            aria-label={spec.id === "texture" ? "Surface" : "Material"}
            className="flex flex-wrap gap-1 pt-0.5"
          >
            {spec.materials.map((m) => (
              <button
                key={m.id}
                role="radio"
                aria-checked={p.material === m.id}
                onClick={() => onChange(spec.id, { material: m.id })}
                className={`rounded-ctrl px-2 py-1 text-[11px] font-medium transition ${
                  p.material === m.id
                    ? "selected text-icon-on"
                    : "bg-ctrl text-ink hoverable"
                }`}
              >
                {m.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
