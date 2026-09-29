/**
 * Remove a solid background baked into a frame's pixels (e.g. the pink of the
 * sheet a sprite was cut from), so the artwork can move without dragging its
 * background along.
 *
 * Uses the same clean-edge engine as the cutter, with the whole frame as one
 * cell: the background colour is measured from the border, everything reachable
 * from the border without crossing the sprite becomes transparent, enclosed
 * parts (eyes, mouths) stay, and edge pixels are un-blended from the colour.
 */

import { buildOccupancy } from "./occupancy";
import { extractCleanCells } from "./slice";
import type { SpriteGrid } from "./types";

export interface RemovedBackground {
  readonly image: ImageData;
  /** The colour that was removed, packed 0xRRGGBB. */
  readonly background: number;
}

/** null when the frame has no single background colour to remove (already
 *  transparent, or a busy/gradient background). */
export function removeFrameBackground(image: ImageData): RemovedBackground | null {
  const field = buildOccupancy(image);
  if (field.kind !== "background" || field.background === null) return null;
  const w = image.width, h = image.height;
  const grid: SpriteGrid = {
    cols: 1, rows: 1, cellWidth: w, cellHeight: h, originX: 0, originY: 0,
    cutsX: [0, w], cutsY: [0, h], uniform: true,
  };
  const result = extractCleanCells(image, grid);
  if (!result.cleaned) return null;
  return { image: result.frames[0], background: field.background };
}
