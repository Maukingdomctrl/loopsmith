"use client";

/**
 * The floating tool rail on the canvas: draw, colour, guides, frame actions
 * and view. It owns no document state — every control is wired to state that
 * already lives in Canvas / page.tsx. It only remembers which flyout is open
 * and which button the tooltip is for.
 *
 * Flyouts and the tooltip render beside the rail (not inside it), because
 * the rail scrolls on short screens and would clip them.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import {
  ArrowUpRight,
  Brush,
  Circle,
  Copy,
  Eraser,
  EyeOff,
  Grid3x3,
  Maximize,
  Minus,
  PaintBucket,
  Pencil,
  PersonStanding,
  Pipette,
  Plus,
  Shapes,
  Slash,
  Smile,
  Square,
  SquareX,
  Star,
  Trash2,
  Triangle,
} from "lucide-react";
import type { CanvasBackground } from "@/types/layer";
import { BACKGROUND_SWATCHES, checkerStyle } from "@/styles/tokens";

export type RailTool = "pencil" | "brush" | "eraser" | "fill" | "picker";
type FlyoutId = "shapes" | "background" | "guides";

interface Props {
  railRef?: Ref<HTMLDivElement>;
  /** Tool currently in use ("none" when no paint tool is picked). */
  activeTool: string;
  onToolClick: (tool: RailTool) => void;
  /** The brush panel is open (the Brush button's popup). */
  brushPanelOpen: boolean;
  /** Paint tools are unavailable (e.g. during playback). */
  toolsDisabled?: boolean;

  paintColor: string;
  onPaintColorChange: (color: string) => void;

  background: CanvasBackground;
  onBackgroundChange?: (next: CanvasBackground) => void;

  onionSkin: boolean;
  onOnionSkinChange?: (on: boolean) => void;

  showGuides: boolean;
  guideMode: "face" | "fullbody";
  onGuidesChange?: (show: boolean, mode: "face" | "fullbody") => void;

  onDuplicateFrame?: () => void;
  onClearFrame?: () => void;
  onDeleteFrame?: () => void;
  frameActionsDisabled?: boolean;

  /** Zoom of the selected layer, 1 = 100%. */
  zoom: number;
  zoomDisabled?: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;

  /** Called when a flyout opens, so the brush panel can make way. */
  onFlyoutOpen?: () => void;
}

/** Where the rail sits in the canvas area, and where flyouts open. */
const RAIL_LEFT = 20;
const RAIL_TOP = 52;
const FLYOUT_LEFT = 76;

export default function ToolRail(props: Props) {
  const {
    railRef, activeTool, onToolClick, brushPanelOpen, toolsDisabled,
    paintColor, onPaintColorChange, background, onBackgroundChange,
    onionSkin, onOnionSkinChange, showGuides, guideMode, onGuidesChange,
    onDuplicateFrame, onClearFrame, onDeleteFrame, frameActionsDisabled,
    zoom, zoomDisabled, onZoomIn, onZoomOut, onFit, onFlyoutOpen,
  } = props;

  const innerRef = useRef<HTMLDivElement | null>(null);
  const flyoutRef = useRef<HTMLDivElement | null>(null);
  const [flyout, setFlyout] = useState<{ id: FlyoutId; top: number } | null>(null);
  const [tip, setTip] = useState<{ label: string; shortcut?: string; top: number } | null>(null);

  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      innerRef.current = el;
      if (typeof railRef === "function") railRef(el);
      else if (railRef) (railRef as { current: HTMLDivElement | null }).current = el;
    },
    [railRef]
  );

  /** A button's top edge, relative to the canvas area the rail lives in. */
  const topOf = (el: HTMLElement) => {
    const host = innerRef.current?.offsetParent as HTMLElement | null;
    if (!host) return RAIL_TOP;
    return el.getBoundingClientRect().top - host.getBoundingClientRect().top;
  };

  const toggleFlyout = (id: FlyoutId, el: HTMLElement) => {
    setTip(null);
    if (flyout?.id === id) {
      setFlyout(null);
      return;
    }
    onFlyoutOpen?.();
    setFlyout({ id, top: topOf(el) - 6 });
  };

  // One flyout at a time; click outside or Escape closes it. The opener
  // button toggles it itself, so clicks on the rail are left alone.
  useEffect(() => {
    if (!flyout) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (flyoutRef.current?.contains(t) || innerRef.current?.contains(t))) return;
      setFlyout(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFlyout(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [flyout]);

  // Keep a flyout inside the canvas area: on short screens it moves up.
  useLayoutEffect(() => {
    const el = flyoutRef.current;
    const host = el?.offsetParent as HTMLElement | null;
    if (!el || !host || !flyout) return;
    const max = host.clientHeight - el.offsetHeight - 12;
    el.style.top = `${Math.max(12, Math.min(flyout.top, max))}px`;
  }, [flyout]);

  // The rail can scroll on short screens; a flyout would drift from its button.
  const closeOnScroll = () => {
    if (flyout) setFlyout(null);
    if (tip) setTip(null);
  };

  const showTip = (el: HTMLElement, label: string, shortcut?: string) =>
    setTip({ label, shortcut, top: topOf(el) + el.offsetHeight / 2 });
  const hideTip = () => setTip(null);

  /** One 36×36 rail button with its tooltip. */
  const button = (o: {
    label: string;
    shortcut?: string;
    icon: ReactNode;
    onClick: (el: HTMLButtonElement) => void;
    selected?: boolean;
    disabled?: boolean;
    danger?: boolean;
    flyout?: FlyoutId;
    tool?: string;
    pressed?: boolean;
    /** Opens a dialog (the brush panel) rather than a flyout. */
    dialog?: boolean;
  }) => (
    <button
      key={o.label}
      type="button"
      data-tool={o.tool}
      disabled={o.disabled}
      aria-label={o.shortcut ? `${o.label} (${o.shortcut})` : o.label}
      aria-pressed={o.pressed}
      aria-haspopup={o.flyout ? "menu" : o.dialog ? "dialog" : undefined}
      aria-expanded={o.flyout ? flyout?.id === o.flyout : o.dialog ? brushPanelOpen : undefined}
      onClick={(e) => o.onClick(e.currentTarget)}
      onMouseEnter={(e) => showTip(e.currentTarget, o.label, o.shortcut)}
      onMouseLeave={hideTip}
      onFocus={(e) => showTip(e.currentTarget, o.label, o.shortcut)}
      onBlur={hideTip}
      className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-tool disabled:opacity-30 ${
        o.selected
          ? "selected text-icon-on"
          : o.danger
            ? "text-danger hoverable"
            : "text-icon hoverable hover:text-ink"
      }`}
    >
      {o.icon}
      {o.flyout && <Corner />}
    </button>
  );

  const divider = (key: string) => <span key={key} className="my-[3px] h-px w-4 shrink-0 bg-line-strong" />;

  const bgSwatchStyle = background.transparent ? checkerStyle : { background: background.color };

  return (
    <>
      <div
        ref={setRefs}
        onScroll={closeOnScroll}
        role="toolbar"
        aria-orientation="vertical"
        aria-label="Tools"
        className="absolute z-50 flex w-12 flex-col items-center gap-0.5 overflow-y-auto overflow-x-hidden rounded-panel border border-line bg-panel p-1.5 shadow-rail [scrollbar-width:none]"
        style={{ left: RAIL_LEFT, top: RAIL_TOP, maxHeight: `calc(100% - ${RAIL_TOP + 20}px)` }}
      >
        {/* 1. Draw */}
        {(
          [
            ["pencil", Pencil, "Pencil", "P"],
            ["brush", Brush, "Brush", "B"],
            ["eraser", Eraser, "Eraser", "E"],
          ] as const
        ).map(([id, Icon, label, key]) =>
          button({
            label,
            shortcut: key,
            tool: id,
            icon: <Icon size={17} />,
            selected: activeTool === id,
            pressed: activeTool === id,
            disabled: toolsDisabled,
            onClick: () => onToolClick(id),
            ...(id === "brush" ? { pressed: undefined, dialog: true } : {}),
          })
        )}
        {button({
          label: "Shapes",
          icon: <Shapes size={17} />,
          flyout: "shapes",
          selected: flyout?.id === "shapes",
          onClick: (el) => toggleFlyout("shapes", el),
        })}

        {divider("d1")}

        {/* 2. Colour */}
        {button({
          label: "Fill",
          shortcut: "G",
          tool: "fill",
          icon: <PaintBucket size={17} />,
          selected: activeTool === "fill",
          pressed: activeTool === "fill",
          disabled: toolsDisabled,
          onClick: () => onToolClick("fill"),
        })}
        {button({
          label: "Eyedropper",
          shortcut: "I",
          tool: "picker",
          icon: <Pipette size={17} />,
          selected: activeTool === "picker",
          pressed: activeTool === "picker",
          disabled: toolsDisabled,
          onClick: () => onToolClick("picker"),
        })}
        <label
          className="relative flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-tool hoverable"
          onMouseEnter={(e) => showTip(e.currentTarget, "Current colour")}
          onMouseLeave={hideTip}
        >
          <span
            className="h-[26px] w-[26px] rounded-full ring-2 ring-line-strong"
            style={{ background: paintColor }}
          />
          <input
            type="color"
            value={paintColor}
            onChange={(e) => onPaintColorChange(e.target.value)}
            onFocus={(e) => showTip(e.currentTarget.parentElement!, "Current colour")}
            onBlur={hideTip}
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label="Current colour"
          />
        </label>
        {button({
          label: "Background colour",
          icon: (
            <span
              className="h-6 w-6 rounded-[6px] ring-1 ring-line-strong"
              style={bgSwatchStyle}
            />
          ),
          flyout: "background",
          disabled: !onBackgroundChange,
          onClick: (el) => toggleFlyout("background", el),
        })}

        {divider("d2")}

        {/* 3. Guides */}
        {button({
          label: onionSkin ? "Onion skin: on" : "Onion skin: off",
          icon: <OnionIcon on={onionSkin} />,
          selected: onionSkin,
          pressed: onionSkin,
          disabled: !onOnionSkinChange,
          onClick: () => onOnionSkinChange?.(!onionSkin),
        })}
        {button({
          label: "Emoji guides",
          icon: <Smile size={17} />,
          flyout: "guides",
          selected: showGuides,
          disabled: !onGuidesChange,
          onClick: (el) => toggleFlyout("guides", el),
        })}

        {divider("d3")}

        {/* 4. Frame actions */}
        {button({
          label: "Duplicate frame",
          icon: <Copy size={16} />,
          disabled: frameActionsDisabled || !onDuplicateFrame,
          onClick: () => onDuplicateFrame?.(),
        })}
        {button({
          label: "Clear frame",
          icon: <SquareX size={17} />,
          disabled: frameActionsDisabled || !onClearFrame,
          onClick: () => onClearFrame?.(),
        })}
        {button({
          label: "Delete frame",
          icon: <Trash2 size={17} />,
          danger: true,
          disabled: frameActionsDisabled || !onDeleteFrame,
          onClick: () => onDeleteFrame?.(),
        })}

        {divider("d4")}

        {/* 5. View */}
        {button({
          label: "Zoom in",
          icon: <Plus size={17} />,
          disabled: zoomDisabled,
          onClick: onZoomIn,
        })}
        <span
          className="flex h-7 shrink-0 items-center font-mono text-[13px] text-ink"
          aria-live="polite"
          aria-label={`Zoom ${Math.round(zoom * 100)} percent`}
        >
          {Math.round(zoom * 100)}%
        </span>
        {button({
          label: "Zoom out",
          icon: <Minus size={17} />,
          disabled: zoomDisabled,
          onClick: onZoomOut,
        })}
        {button({
          label: "Fit to screen",
          icon: <Maximize size={16} />,
          disabled: zoomDisabled,
          onClick: onFit,
        })}
      </div>

      {flyout && (
        <div
          ref={flyoutRef}
          role="menu"
          aria-label={
            flyout.id === "shapes" ? "Shapes" : flyout.id === "background" ? "Background colour" : "Emoji guides"
          }
          className="absolute z-[70] flex w-12 flex-col items-center gap-0.5 rounded-panel border border-line-strong bg-ctrl p-1.5 shadow-flyout"
          style={{ left: FLYOUT_LEFT, top: flyout.top }}
        >
          {flyout.id === "shapes" && <ShapesFlyout />}
          {flyout.id === "background" && onBackgroundChange && (
            <BackgroundFlyout background={background} onChange={onBackgroundChange} />
          )}
          {flyout.id === "guides" && onGuidesChange && (
            <GuidesFlyout
              showGuides={showGuides}
              guideMode={guideMode}
              onChange={(show, mode) => {
                onGuidesChange(show, mode);
                setFlyout(null);
              }}
            />
          )}
        </div>
      )}

      {/* Tooltips share the spot beside the rail with flyouts and the brush panel. */}
      {tip && !flyout && !brushPanelOpen && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-[80] flex -translate-y-1/2 items-center gap-2 whitespace-nowrap rounded-[6px] bg-ink px-2 py-1 text-[12px] font-semibold text-on-light shadow-panel"
          style={{ left: FLYOUT_LEFT, top: tip.top }}
        >
          {tip.label}
          {tip.shortcut && <span className="font-mono font-medium text-ink-dim">{tip.shortcut}</span>}
        </div>
      )}
    </>
  );
}

/** Small triangle in a button's corner: the button opens a flyout. */
function Corner() {
  return (
    <svg
      aria-hidden
      width="5"
      height="5"
      viewBox="0 0 5 5"
      className="absolute bottom-[3px] right-[3px] fill-current opacity-80"
    >
      <path d="M5 0V5H0Z" />
    </svg>
  );
}

/** Two overlapping circles: accent when onion skin is on. */
function OnionIcon({ on }: { on: boolean }) {
  return (
    <svg
      aria-hidden
      width="18"
      height="18"
      viewBox="0 0 18 18"
      fill="none"
      strokeWidth="1.6"
      className={on ? "text-icon-accent" : ""}
    >
      <circle cx="6.75" cy="9" r="4.5" stroke="currentColor" opacity={on ? 0.55 : 1} />
      <circle cx="11.25" cy="9" r="4.5" stroke="currentColor" />
    </svg>
  );
}

const flyItem =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-tool text-icon hoverable disabled:cursor-not-allowed disabled:opacity-30";

/** Shapes need a drawing tool the app does not have yet: shown, disabled. */
function ShapesFlyout() {
  const soon = " (not available yet)";
  const items: [string, ReactNode][] = [
    ["Line", <Slash key="i" size={16} />],
    ["Rectangle", <Square key="i" size={16} />],
    ["Ellipse", <Circle key="i" size={16} />],
    ["Triangle", <Triangle key="i" size={16} />],
    ["Arrow", <ArrowUpRight key="i" size={16} />],
    ["Star", <Star key="i" size={16} />],
  ];
  return (
    <>
      {items.map(([label, icon]) => (
        <button key={label} role="menuitem" disabled title={label + soon} aria-label={label + soon} className={flyItem}>
          {icon}
        </button>
      ))}
      <span className="my-[3px] h-px w-4 bg-line-strong" />
      <button
        role="menuitemcheckbox"
        aria-checked={false}
        disabled
        title={"Fill shape" + soon}
        aria-label={"Fill shape" + soon}
        className={flyItem}
      >
        <span className="h-3.5 w-3.5 rounded-[3px] bg-icon" />
      </button>
    </>
  );
}

function BackgroundFlyout({
  background,
  onChange,
}: {
  background: CanvasBackground;
  onChange: (next: CanvasBackground) => void;
}) {
  const isPreset = BACKGROUND_SWATCHES.some(
    (s) => s.color.toLowerCase() === background.color.toLowerCase()
  );
  const ring = (active: boolean) =>
    active ? "ring-2 ring-accent" : "ring-1 ring-line-strong";
  const swatch = "h-8 w-8 shrink-0 rounded-ctrl hoverable";

  return (
    <div className="flex flex-col items-center gap-1.5 py-0.5">
      <button
        role="menuitemradio"
        aria-checked={background.transparent}
        onClick={() => onChange({ ...background, transparent: true })}
        title="Transparent"
        aria-label="Transparent background"
        className={`${swatch} ${ring(background.transparent)}`}
        style={checkerStyle}
      />
      {BACKGROUND_SWATCHES.map((s) => {
        const active = !background.transparent && s.color.toLowerCase() === background.color.toLowerCase();
        return (
          <button
            key={s.color}
            role="menuitemradio"
            aria-checked={active}
            onClick={() => onChange({ ...background, transparent: false, color: s.color })}
            title={s.name}
            aria-label={`${s.name} background`}
            className={`${swatch} ${ring(active)}`}
            style={{ background: s.color }}
          />
        );
      })}
      {/* Custom colour */}
      <label
        title="Custom colour"
        className={`relative flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-ctrl text-icon hoverable ${
          !background.transparent && !isPreset ? "ring-2 ring-accent" : "border border-dashed border-line-strong"
        }`}
        style={!background.transparent && !isPreset ? { background: background.color } : undefined}
      >
        {(background.transparent || isPreset) && <Plus size={14} />}
        <input
          type="color"
          value={background.color}
          onChange={(e) => onChange({ ...background, transparent: false, color: e.target.value })}
          className="absolute inset-0 cursor-pointer opacity-0"
          aria-label="Custom background colour"
        />
      </label>
      {background.transparent && (
        <>
          <span className="my-[3px] h-px w-4 bg-line-strong" />
          <button
            role="menuitemcheckbox"
            aria-checked={background.checkerboard}
            onClick={() => onChange({ ...background, checkerboard: !background.checkerboard })}
            title="Show checkerboard (preview only, never exported)"
            aria-label="Show checkerboard"
            className={`flex h-8 w-8 items-center justify-center rounded-ctrl ${
              background.checkerboard ? "selected text-icon-on" : "text-icon hoverable"
            }`}
          >
            <Grid3x3 size={15} />
          </button>
        </>
      )}
    </div>
  );
}

function GuidesFlyout({
  showGuides,
  guideMode,
  onChange,
}: {
  showGuides: boolean;
  guideMode: "face" | "fullbody";
  onChange: (show: boolean, mode: "face" | "fullbody") => void;
}) {
  const item = (active: boolean) =>
    `flex h-9 w-9 items-center justify-center rounded-tool ${active ? "selected text-icon-on" : "text-icon hoverable"}`;
  return (
    <>
      <button
        role="menuitemradio"
        aria-checked={showGuides && guideMode === "face"}
        onClick={() => onChange(true, "face")}
        title="Face guides"
        aria-label="Face guides"
        className={item(showGuides && guideMode === "face")}
      >
        <Smile size={17} />
      </button>
      <button
        role="menuitemradio"
        aria-checked={showGuides && guideMode === "fullbody"}
        onClick={() => onChange(true, "fullbody")}
        title="Full body guides"
        aria-label="Full body guides"
        className={item(showGuides && guideMode === "fullbody")}
      >
        <PersonStanding size={17} />
      </button>
      <span className="my-[3px] h-px w-4 bg-line-strong" />
      <button
        role="menuitemradio"
        aria-checked={!showGuides}
        onClick={() => onChange(false, guideMode)}
        title="Hide emoji guides"
        aria-label="Hide emoji guides"
        className={item(!showGuides)}
      >
        <EyeOff size={16} />
      </button>
    </>
  );
}
