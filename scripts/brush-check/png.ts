/** A minimal PNG encoder (greyscale), so the check needs no dependencies. */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import type { RasterSurface } from "@/lib/raster/surface";

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
}

/** Black ink over white, 8-bit grey, optional nearest-neighbour zoom of a crop. */
export function writePng(
  path: string, s: RasterSurface, W: number, H: number,
  crop?: { x: number; y: number; w: number; h: number; zoom: number }
): void {
  const img = s.toImageData().data;
  const c = crop ?? { x: 0, y: 0, w: W, h: H, zoom: 1 };
  const ow = c.w * c.zoom, oh = c.h * c.zoom;
  const raw = new Uint8Array(oh * (ow + 1));
  for (let y = 0; y < oh; y++) {
    raw[y * (ow + 1)] = 0;
    for (let x = 0; x < ow; x++) {
      const sx = c.x + Math.floor(x / c.zoom), sy = c.y + Math.floor(y / c.zoom);
      const a = img[(sy * W + sx) * 4 + 3];
      raw[y * (ow + 1) + 1 + x] = 255 - a;
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, ow); dv.setUint32(4, oh);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  writeFileSync(path, out);
}
