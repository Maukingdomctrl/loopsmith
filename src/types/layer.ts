/**
 * The layer model.
 *
 * LAYER 0 IS PERMANENT. Every frame has exactly one `kind: "base"` layer, it
 * is always at index 0, and it cannot be deleted, reordered, or duplicated
 * into a second base. This is not a UI nicety: the base layer is what
 * `frame.x/y/zoom/rotation/stab` map onto, so the existing stabilizer, export
 * and onion-skin paths keep working unchanged. Allowing it to disappear would
 * make every legacy code path conditional.
 */

import type { Rect, Vec2 } from "@/types/geometry";
import type { Pose } from "@/lib/geometry/pose";
import type { PencilStroke } from "@/lib/pencil/types";

export type LayerKind = "base" | "raster";

/** Only modes with an exact Canvas2D globalCompositeOperation equivalent are
 *  offered, so what the editor shows is byte-identical to what GIF export
 *  produces. */
export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "difference";

export const BLEND_MODES: readonly BlendMode[] = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten", "difference",
];

export const BLEND_TO_COMPOSITE: Readonly<Record<BlendMode, GlobalCompositeOperation>> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  difference: "difference",
};

export interface Layer {
  readonly id: string;
  readonly kind: LayerKind;
  readonly name: string;

  /** L0 pixels. Data URL in memory; replaced by a storage ref on persist. */
  readonly image: string | null;

  /** Native bitmap size, in source pixels. Authoritative even when `image` is
   *  momentarily null (e.g. hydrating from IndexedDB), so geometry never
   *  depends on decode completing. */
  readonly size: { readonly w: number; readonly h: number };

  /** Local→canvas transform, in canonical pose form. */
  readonly pose: Pose;

  /** Local-space crop. null = full bitmap. Non-destructive: the pixels are
   *  untouched, so a crop is fully reversible until explicitly flattened. */
  readonly crop: Rect | null;

  readonly opacity: number;      // [0,1]
  readonly visible: boolean;
  readonly locked: boolean;
  readonly blend: BlendMode;

  /** Pencil strokes, stored as recorded physics in layer space and drawn over
   *  `image` analytically at render time. Never baked unless a pixel tool
   *  (fill, lasso) needs pixels. */
  readonly strokes?: readonly PencilStroke[];
}

/** Has something to draw: pixels or pencil strokes. */
export const layerHasContent = (l: Layer): boolean =>
  !!l.image || !!l.strokes?.length;

/** Document-level crop, in canvas space. Distinct from layer crop because a
 *  rotated layer's intersection with a canvas-space rect is not a local rect —
 *  so canvas cropping must be a clip on the document, not on each layer. */
export interface DocumentCrop {
  readonly rect: Rect;
  /** Committed crops resize the export surface; previewed ones only clip. */
  readonly committed: boolean;
}

export interface CanvasBackground {
  /** The transparency toggle. false ⇒ `color` is painted under every layer. */
  readonly transparent: boolean;
  readonly color: string;
  /** Checkerboard is a VIEW aid only; never exported. */
  readonly checkerboard: boolean;
}

export const DEFAULT_BACKGROUND: CanvasBackground = {
  transparent: true,
  color: "#FFFFFF",
  checkerboard: true,
};

export type LayerId = string;

export interface LayerSelection {
  readonly primary: LayerId | null;
  readonly ids: readonly LayerId[];
}

export const EMPTY_SELECTION: LayerSelection = { primary: null, ids: [] };

/* ---------------- guards ---------------- */

export const isBaseLayer = (l: Layer): boolean => l.kind === "base";

/** Editable ⇔ unlocked. Visibility deliberately does NOT block editing: the
 *  standard workflow of hiding a layer while nudging its neighbour requires
 *  the hidden layer to stay selectable from the panel. */
export const isLayerEditable = (l: Layer): boolean => !l.locked;

export const isLayerRenderable = (l: Layer): boolean =>
  l.visible && l.opacity > 0 && layerHasContent(l);
