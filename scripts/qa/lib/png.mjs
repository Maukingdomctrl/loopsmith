// Comparing captured PNGs: byte for byte, then (for the ones that differ) by
// pixel, decoded in the browser.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Every .png under `dir`, as paths relative to it (sorted). */
export function listPngs(dir) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".png")) out.push(path.relative(dir, p).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** Byte comparison of two capture folders. */
export function compareDirs(a, b) {
  const la = listPngs(a), lb = new Set(listPngs(b));
  const res = { identical: [], different: [], onlyA: [], onlyB: [] };
  for (const f of la) {
    if (!lb.has(f)) res.onlyA.push(f);
    else if (fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f)))) res.identical.push(f);
    else res.different.push(f);
    lb.delete(f);
  }
  res.onlyB = [...lb].sort();
  return res;
}

/**
 * How two PNGs differ, pixel by pixel: differing pixels, the largest channel
 * difference, their bounding box, and how the differences are spread.
 * `page` is any page (about:blank will do).
 */
export async function pixelDiff(page, fileA, fileB) {
  return page.evaluate(async ([a, b]) => {
    const load = async (s) => {
      const im = new Image();
      im.src = "data:image/png;base64," + s;
      await im.decode();
      const c = document.createElement("canvas");
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
      const x = c.getContext("2d");
      x.drawImage(im, 0, 0);
      return x.getImageData(0, 0, c.width, c.height);
    };
    const A = await load(a), B = await load(b);
    if (A.width !== B.width || A.height !== B.height) {
      return { sizeMismatch: `${A.width}x${A.height} vs ${B.width}x${B.height}` };
    }
    let n = 0, max = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    const buckets = { "1-2": 0, "3-5": 0, "6-10": 0, "11-20": 0, ">20": 0 };
    for (let j = 0; j < A.data.length; j += 4) {
      let d = 0;
      for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(A.data[j + k] - B.data[j + k]));
      if (!d) continue;
      n++;
      max = Math.max(max, d);
      buckets[d <= 2 ? "1-2" : d <= 5 ? "3-5" : d <= 10 ? "6-10" : d <= 20 ? "11-20" : ">20"]++;
      const p = j / 4, x = p % A.width, y = (p / A.width) | 0;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    return { width: A.width, height: A.height, pixels: n, max, box: n ? [x0, y0, x1, y1] : null, buckets };
  }, [fs.readFileSync(fileA).toString("base64"), fs.readFileSync(fileB).toString("base64")]);
}

/** One line for a pixelDiff result. */
export function describeDiff(d) {
  if (d.sizeMismatch) return `size differs (${d.sizeMismatch})`;
  if (!d.pixels) return "identical pixels (encoding differs)";
  const share = ((d.pixels / (d.width * d.height)) * 100).toFixed(2);
  return `${d.pixels} px differ (${share}%), max ${d.max}, box ${d.box.join(",")}`;
}
