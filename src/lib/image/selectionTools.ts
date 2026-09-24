export interface Point {
  x: number;
  y: number;
}

/* ---------- Brush interpolation ---------- */

export function rasterBrushLine(
  from: Point,
  to: Point,
  radius: number
): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);

  const step = Math.max(1, radius * 0.35);
  const n = Math.ceil(dist / step);

  const pts: Point[] = [];

  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0 : i / n;
    pts.push({
      x: from.x + dx * t,
      y: from.y + dy * t,
    });
  }

  return pts;
}

/* ---------- Lasso ---------- */

export function pointInPolygon(
  p: Point,
  polygon: Point[]
): boolean {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersect =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-9) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}

/* ---------- Magic Wand ---------- */

export function colorDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number
): number {
  return Math.sqrt(
    (r1 - r2) ** 2 +
    (g1 - g2) ** 2 +
    (b1 - b2) ** 2
  );
}

export function floodSelect(
  image: ImageData,
  startX: number,
  startY: number,
  tolerance: number
): Uint8Array {
  const { width, height, data } = image;

  const visited = new Uint8Array(width * height);
  const queue: number[] = [];

  const idx = (startY * width + startX) * 4;

  const sr = data[idx];
  const sg = data[idx + 1];
  const sb = data[idx + 2];

  queue.push(startX, startY);

  while (queue.length) {
    const y = queue.pop()!;
    const x = queue.pop()!;

    if (x < 0 || y < 0 || x >= width || y >= height) continue;

    const id = y * width + x;
    if (visited[id]) continue;

    const p = id * 4;

    const d = colorDistance(
      sr,
      sg,
      sb,
      data[p],
      data[p + 1],
      data[p + 2]
    );

    if (d > tolerance) continue;

    visited[id] = 1;

    queue.push(
      x + 1, y,
      x - 1, y,
      x, y + 1,
      x, y - 1
    );
  }

  return visited;
}