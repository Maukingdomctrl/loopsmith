import GIF from "gif.js.optimized";
import type { Frame } from "@/types/frame";
import { drawFrameLayers } from "@/lib/drawFrame";
import { preloadFrameBitmaps } from "@/lib/layers/flatten";
import type { CanvasBackground } from "@/types/layer";
import { DEFAULT_BACKGROUND } from "@/types/layer";




export type ExportLimit = 512 | 256 | "none";

export async function exportGIF(
  frames: Frame[],
  size: 128 | 256 | 320 | 512,
  fps: number,
  limit: ExportLimit,
  background: CanvasBackground = DEFAULT_BACKGROUND
): Promise<Blob> {
  const hasArt = frames.some(
  (f) => f.image || f.layers?.some((l) => l.image && l.visible)
);

if (!hasArt) {
  throw new Error("No frames with artwork to export");
}
  // HD export (no file size restriction)
  if (limit === "none") {
  return renderGIF(frames, size, fps, 1, background);
}

  // Target ranges
  const minBytes = limit === 512 ? 480 * 1024 : 220 * 1024;
  const maxBytes = limit === 512 ? 500 * 1024 : 251 * 1024;

  let closest: Blob | null = null;

  // Quality: 1 = highest quality, 30 = strongest compression
  for (let quality = 1; quality <= 30; quality++) {
    const blob = await renderGIF(frames, size, fps, quality, background);
    // Perfect range → stop immediately
    if (blob.size >= minBytes && blob.size <= maxBytes) {
      return blob;
    }

    // Keep the largest valid blob below the ceiling
    if (blob.size <= maxBytes) {
      if (!closest || blob.size > closest.size) {
        closest = blob;
      }
    }
  }

  // If nothing lands in range, return the closest one
    return closest ?? renderGIF(frames, size, fps, 30, background);
}

async function renderGIF(
  frames: Frame[],
  size: number,
  fps: number,
  quality: number,
  background: CanvasBackground
): Promise<Blob> {
  const gif = new GIF({
  workers: 2,
  quality,
  width: size,
  height: size,
  workerScript: "/gif.worker.js",
  ...(background.transparent ? { transparent: "0x000000" } : {}),
});
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext("2d", {
    willReadFrequently: true,
  });

  if (!ctx) throw new Error("Canvas unavailable");

  for (const frame of frames) {
  const renderable =
    frame.layers?.filter((l) => l.image && l.visible) ?? [];

  if (!renderable.length && !frame.image) continue;

  await preloadFrameBitmaps(frame.layers ?? []);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size, size);

  drawFrameLayers(ctx, frame, size, {
    background,
    checkerboard: false,
    smoothing: true,
  });

    // GIF transparency is all-or-nothing: decide each pixel cleanly.
  if (background.transparent) {
    const img = ctx.getImageData(0, 0, size, size);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) {
        d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 255; // → transparent key
      } else {
        d[i + 3] = 255;
        // keep real black art visible (not mistaken for the transparent key)
        if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0) d[i + 2] = 1;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  gif.addFrame(canvas, {
    copy: true,
    delay: (1000 / fps) * (frame.duration || 1),
  });
}

  return new Promise((resolve) => {
    gif.on("finished", (blob: Blob) => resolve(blob));
    gif.render();
  });
}

