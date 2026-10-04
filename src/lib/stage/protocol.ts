/**
 * Messages between the stage client (main thread) and the stage worker.
 *
 * Pixels and strokes cross once. A frame names its decoded images and its
 * strokes by key; the client keeps track of what the worker holds, sends what
 * it lacks along with the frame that needs it, and tells it what to let go.
 */

import type { CanvasBackground, DocumentCrop, Layer } from "@/types/layer";
import type { PencilStroke } from "@/lib/pencil/types";
import type { LiveRaster } from "./renderer";

/** A layer as the worker gets it: `image` and `mask.image` are image keys,
 *  `strokes` are stroke keys. */
export type StageLayer = Omit<Layer, "strokes"> & { readonly strokes?: readonly number[] };

export interface StageFrame {
  readonly layers: readonly StageLayer[];
  readonly crop: DocumentCrop | null;
}

/** A pencil stroke in progress: the samples added since the last draw. */
export interface StageLivePencil {
  readonly kind: "pencil";
  readonly layerId: string;
  /** A new key starts a new stroke. */
  readonly key: number;
  readonly stroke: Omit<PencilStroke, "pts">;
  readonly pts: readonly number[];
}

export type StageRequest =
  | { readonly type: "init"; readonly canvas: OffscreenCanvas }
  | {
      readonly type: "draw";
      readonly size: number;
      readonly frame: StageFrame;
      readonly background: CanvasBackground;
      readonly interactive: boolean;
      /** Draw images as the main thread's CPU raster would (stage/geometry.ts). */
      readonly emulate: boolean;
      /** What the frame refers to that the worker does not hold yet. */
      readonly images: readonly { readonly key: string; readonly bitmap: ImageBitmap }[];
      readonly levels: readonly { readonly key: string; readonly level: string; readonly bitmap: ImageBitmap }[];
      readonly strokes: readonly { readonly key: number; readonly stroke: PencilStroke }[];
      /** What it can let go of. */
      readonly drop: { readonly images: readonly string[]; readonly strokes: readonly number[] };
      readonly live: LiveRaster | StageLivePencil | null;
    }
  | { readonly type: "pick"; readonly id: number; readonly x: number; readonly y: number };

export type StageResponse =
  /** A draw is on the canvas: the client may send the next one. */
  | { readonly type: "drawn" }
  | { readonly type: "picked"; readonly id: number; readonly rgba: Uint8ClampedArray | null };
