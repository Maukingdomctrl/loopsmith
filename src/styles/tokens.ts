/**
 * Design tokens that JavaScript needs as real values: colours drawn into a
 * 2D canvas or set on SVG attributes, and document data such as the
 * background presets. UI chrome uses the CSS tokens in app/globals.css
 * instead; the shared values below are copies of those and must match.
 */

import type { CSSProperties } from "react";

/** Mirrors of the CSS tokens, for SVG attributes and canvas drawing. */
export const ink = "#E0E0EA";
export const panel = "#121221";
export const accent = "#8B6CFF";
export const accentHi = "#A18AFF";
export const primary = "#6F52E8";
export const warn = "#F5C16C";
export const success = "#4FA683";
export const guideLavender = "#8E86B8";
export const guideSage = "#7FA597";

/** Canvas overlays: transform box, crop, lasso, alignment crosshair. */
export const overlay = {
  line: accent,
  active: accentHi,
  handle: ink,
  handleFill: panel,
  pivot: warn,
  lasso: warn,
  crosshair: primary,
  scrim: "rgba(0, 0, 0, 0.6)",
  lassoFill: "rgba(245, 158, 11, 0.15)",
} as const;

/** Spritesheet cutter preview (2D canvas). */
export const cutter = {
  checkerA: "#19192B",
  checkerB: "#121221",
  // Vivid on purpose: cut lines must read over any artwork.
  cut: "#F472B6",
  cutActive: warn,
  labelX: "#A5F3FC",
  labelY: "#FEF08A",
  hover: "#A7F3D0",
  snap: "#4ADE80",
  profile: "rgba(34, 211, 238, 0.3)",
  profileLine: "rgba(250, 204, 21, 0.55)",
  centers: "rgba(74, 222, 128, 0.35)",
} as const;

/** The little pencil / eraser drawn by the brush cursor (an illustration). */
export const cursorArt = {
  rubber: "#F7F3EE",
  sleeve: "#5B8DEF",
  wood: "#E9C79B",
  body: "#F2B632",
  ferrule: "#C9CDD2",
  eraser: "#F29CA3",
  outline: "rgba(0, 0, 0, 0.75)",
} as const;

/** Checkerboard shown for "transparent" (view only, never exported). */
export const checker = { a: "#2A2A3A", b: "#3A3A4C" } as const;

export const checkerStyle: CSSProperties = {
  backgroundColor: checker.a,
  backgroundImage: `linear-gradient(45deg,${checker.b} 25%,transparent 25%,transparent 75%,${checker.b} 75%),linear-gradient(45deg,${checker.b} 25%,transparent 25%,transparent 75%,${checker.b} 75%)`,
  backgroundSize: "10px 10px",
  backgroundPosition: "0 0,5px 5px",
};

/** Canvas background presets (document state: they change the export). */
export const BACKGROUND_SWATCHES = [
  { name: "White", color: "#FFFFFF" },
  { name: "Pink", color: "#F4D6E4" },
  { name: "Blue", color: "#C5DAF5" },
  { name: "Mint", color: "#CDEBDD" },
  { name: "Butter", color: "#F8EBB5" },
  { name: "Navy", color: "#202436" },
  { name: "Black", color: "#0A0A0C" },
] as const;

/** Default paint colour (graphite). */
export const DEFAULT_PAINT = "#2B2B2B";

/** Style for a range input so its filled part shows (see globals.css). */
export const rangeFill = (value: number, min: number, max: number): CSSProperties =>
  ({
    "--fill": `${max > min ? ((value - min) / (max - min)) * 100 : 0}%`,
  }) as CSSProperties;

/** Onion-skin tints, as in Animate: before red-ish, after green-ish. View only. */
export const onion = { before: "rgb(255, 70, 70)", after: "rgb(40, 200, 90)" } as const;

/** Layer-mask thumbnail for an unpainted mask: white shows, black hides. */
export const maskTone = { show: "#FFFFFF", hide: "#000000" } as const;
