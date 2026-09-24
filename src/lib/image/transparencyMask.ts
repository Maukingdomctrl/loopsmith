export interface MaskPixel {
  x: number;
  y: number;
  alpha: number; // 0–255
}

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

export function createMask(width: number, height: number): Uint8ClampedArray {
  return new Uint8ClampedArray(width * height).fill(255); // fully opaque
}

export function eraseCircle(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  feather = 1
) {
  const r2 = radius * radius;
  const outer = radius + feather;
  const outer2 = outer * outer;

  const minX = Math.max(0, Math.floor(cx - outer));
  const maxX = Math.min(width - 1, Math.ceil(cx + outer));
  const minY = Math.max(0, Math.floor(cy - outer));
  const maxY = Math.min(height - 1, Math.ceil(cy + outer));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;

      if (d2 > outer2) continue;

      const i = y * width + x;

      if (d2 <= r2) {
        mask[i] = 0;
      } else {
        const d = Math.sqrt(d2);
        const t = (d - radius) / feather;
        const alpha = Math.round(255 * t);
        mask[i] = Math.min(mask[i], clamp(alpha, 0, 255));
      }
    }
  }
}

export function applyMask(
  image: ImageData,
  mask: Uint8ClampedArray
): ImageData {
  const out = new ImageData(
    new Uint8ClampedArray(image.data),
    image.width,
    image.height
  );

  for (let i = 0; i < mask.length; i++) {
    out.data[i * 4 + 3] = mask[i];
  }

  return out;
}