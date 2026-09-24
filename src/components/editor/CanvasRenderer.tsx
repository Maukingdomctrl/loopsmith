"use client";

import { applyMask } from "@/lib/image/transparencyMask";

interface Props {
  ctx: CanvasRenderingContext2D;
  image: CanvasImageSource;
  imageData: ImageData;
  mask?: Uint8ClampedArray;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function renderFrame({
  ctx,
  image,
  imageData,
  mask,
  x,
  y,
  width,
  height,
}: Props) {
  // Draw original frame
  ctx.drawImage(image, x, y, width, height);

  // No transparency edits
  if (!mask) return;

  // Apply non-destructive alpha mask
  const masked = applyMask(imageData, mask);

  const off = document.createElement("canvas");
  off.width = imageData.width;
  off.height = imageData.height;

  const offCtx = off.getContext("2d")!;
  offCtx.putImageData(masked, 0, 0);

  // Replace only this frame
  ctx.clearRect(x, y, width, height);
  ctx.drawImage(off, x, y, width, height);
}