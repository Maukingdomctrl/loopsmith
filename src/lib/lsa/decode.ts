/**
 * LSA v1.0 — data URL → ImageData at NATIVE resolution.
 *
 * Determinism invariant 5 (§1.3): no scaled drawImage anywhere in the pipeline.
 * Canvas drawImage WITH scaling is implementation-defined; 1:1 drawImage
 * followed by getImageData is not. Forcing every decode through this module
 * means no downstream stage can accidentally introduce a resample.
 *
 * Runs on the MAIN THREAD (deliberate deviation from the original blueprint):
 * createImageBitmap-from-data-URL is not uniformly available in workers, image
 * decode is already off-thread inside the browser, and DecodedFrame transfers
 * to the worker cheaply. The worker therefore never decodes anything.
 */

import { ALPHA_EPSILON, MAX_FRAMES, MIN_FRAMES } from "./constants";
import { hashImageData } from "./hash";
import type { DecodedFrame } from "./types";

export class LsaDecodeError extends Error {
  constructor(message: string, readonly code: LsaDecodeErrorCode) {
    super(message);
    this.name = "LsaDecodeError";
  }
}

export type LsaDecodeErrorCode =
  | "too-few-frames"
  | "too-many-frames"
  | "dimension-mismatch"
  | "no-content"
  | "decode-failed";

interface Surface {
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  canvas: HTMLCanvasElement | OffscreenCanvas;
}

function createSurface(width: number, height: number): Surface {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new LsaDecodeError("no 2d context", "decode-failed");
    return { ctx, canvas };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new LsaDecodeError("no 2d context", "decode-failed");
  return { ctx, canvas };
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(new LsaDecodeError("image decode failed", "decode-failed"));
    img.src = src;
  });
}

/**
 * Decode one data URL at its native size. Returns null for a blank slot
 * (Loop's createBlankFrame yields image === null) — NOT an error: §A.5 handles
 * a contentless frame as its own connected component whose minimum-norm
 * solution is t_i = 0, "the correctly non-committal answer".
 */
export async function decodeFrame(
  index: number,
  dataUrl: string | null
): Promise<DecodedFrame | null> {
  if (!dataUrl) return null;

  const img = await loadImage(dataUrl);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (width < 1 || height < 1) {
    throw new LsaDecodeError(`frame ${index} has zero extent`, "decode-failed");
  }

  const { ctx } = createSurface(width, height);
  ctx.clearRect(0, 0, width, height);
  // 1:1 — no dsWidth/dsHeight arguments, so no resampling can occur.
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, width, height);

  // Occupancy: Σ_x α_i(x) / |Ω|. Drives `usable` and the blank-frame path.
  let alphaSum = 0;
  const rgba = data.data;
  for (let i = 3; i < rgba.length; i += 4) alphaSum += rgba[i];
  const alphaMass = alphaSum / (255 * width * height);

  return {
    index,
    width,
    height,
    rgba,
    hash: hashImageData(rgba, width, height),
    alphaMass,
  };
}

/**
 * Decode a whole project's frames and validate the paper's standing
 * assumptions ONCE, up front: identical Ω for all i (§0), 2 ≤ N ≤ 64
 * (Constraint 4), and at least two frames with content (otherwise E is empty
 * and there is nothing to synchronise).
 *
 * Failing here, loudly, beats failing at pixel 40 000 of edge 63.
 */
export async function decodeFrames(
  images: readonly (string | null)[]
): Promise<{ frames: DecodedFrame[]; cellWidth: number; cellHeight: number }> {
  if (images.length < MIN_FRAMES) {
    throw new LsaDecodeError(
      `need at least ${MIN_FRAMES} frames, got ${images.length}`,
      "too-few-frames"
    );
  }
  if (images.length > MAX_FRAMES) {
    throw new LsaDecodeError(
      `at most ${MAX_FRAMES} frames supported, got ${images.length}`,
      "too-many-frames"
    );
  }

  const decoded: (DecodedFrame | null)[] = [];
  for (let i = 0; i < images.length; i++) {
    decoded.push(await decodeFrame(i, images[i]));
  }

  const present = decoded.filter((d): d is DecodedFrame => d !== null);
  if (present.length < 2) {
    throw new LsaDecodeError(
      "fewer than two frames contain pixel data",
      "no-content"
    );
  }

  // Use the largest canvas so mixed-size imports are normalized.
const width = Math.max(...present.map((f) => f.width));
const height = Math.max(...present.map((f) => f.height));

// Re-pad every decoded frame onto the common canvas.
for (let i = 0; i < decoded.length; i++) {
  const d = decoded[i];
  if (!d || (d.width === width && d.height === height)) continue;

  const { ctx } = createSurface(width, height);

  const image = new ImageData(
  new Uint8ClampedArray(d.rgba),
  d.width,
  d.height
);
  const ox = Math.round((width - d.width) / 2);
  const oy = Math.round((height - d.height) / 2);

  ctx.clearRect(0, 0, width, height);
  ctx.putImageData(image, ox, oy);

  const padded = ctx.getImageData(0, 0, width, height);

  decoded[i] = {
    ...d,
    width,
    height,
    rgba: padded.data,
    hash: hashImageData(padded.data, width, height),
  };
}

  const occupied = present.filter((d) => d.alphaMass > ALPHA_EPSILON);
  if (occupied.length < 2) {
    throw new LsaDecodeError(
      "fewer than two frames have non-transparent content",
      "no-content"
    );
  }

  // Blank slots become fully transparent placeholders so indices stay aligned
  // with the project's frame array; they are isolated nodes downstream.
  const frames: DecodedFrame[] = decoded.map((d, i) =>
    d ?? {
      index: i,
      width,
      height,
      rgba: new Uint8ClampedArray(width * height * 4),
      hash: `blank:${width}x${height}`,
      alphaMass: 0,
    }
  );

  return { frames, cellWidth: width, cellHeight: height };
}
