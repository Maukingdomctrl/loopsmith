// The browser contract the stage worker's image drawing rests on.
//
// A decoded <img> drawn on a page canvas goes through Chromium's image decode
// cache: on CPU raster, shrunk below half size it is first scaled to a mip
// level (halving, rounding up), then drawn bilinearly from it, with float32
// source rects; otherwise drawn bilinearly from the original whatever the
// smoothing quality. The stage worker draws ImageBitmaps, which skip that
// cache, and reproduces it (src/lib/stage/geometry.ts) from levels the page
// makes by drawing the <img> at the level's size.
//
// This checks the contract directly, on the browser in use: page <img> draws
// vs worker ImageBitmap draws with emulated mip levels, over odd sizes,
// sub-rects, densities from 0.2 to 1.3 and rotations — 96 cases, all of
// which must be identical on CPU raster. It also reports which path the
// browser's canvases take (the app probes the same way, stage/client.ts).
// Run it after a Chromium update, or after touching stage/geometry.ts.
//
//   node scripts/qa/image-path.mjs [--path cpu|gpu]
import { launch, options } from "./lib/env.mjs";

const opt = options();
const gpu = String(opt("path", "cpu")) === "gpu";
const browser = await launch({ gpu });
const page = await (await browser.newContext()).newPage();
// any http origin will do (blob workers need one)
await page.route("http://qa.local/**", (r) => r.fulfill({ body: "<!doctype html><title>qa</title>", contentType: "text/html" }));
await page.goto("http://qa.local/");

// Which path decoded images take on this browser's canvases: an enlarged
// image draws "high" exactly like "low" on the CPU path.
const imagePath = await page.evaluate(async () => {
  const art = document.createElement("canvas"); art.width = art.height = 2;
  const a = art.getContext("2d"); a.fillStyle = "#000"; a.fillRect(0, 0, 2, 2); a.fillStyle = "#fff"; a.fillRect(0, 0, 1, 1); a.fillRect(1, 1, 1, 1);
  const img = new Image(); img.src = art.toDataURL("image/png"); await img.decode();
  const read = (q) => { const c = document.createElement("canvas"); c.width = c.height = 256; const x = c.getContext("2d"); x.imageSmoothingQuality = q; x.drawImage(img, 0, 0, 256, 256); return x.getImageData(0, 0, 256, 256).data; };
  const hi = read("high"), lo = read("low");
  return hi.every((v, i) => v === lo[i]) ? "cpu" : "gpu";
});

const out = await page.evaluate(async () => {
  const art = (w, h) => {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d");
    const d = x.createImageData(w, h);
    let s = 9;
    for (let i = 0; i < d.data.length; i++) { s = (s * 1103515245 + 12345) >>> 0; d.data[i] = (s >>> 16) & 255; }
    for (let i = 3; i < d.data.length; i += 4) if (d.data[i] < 60) d.data[i] = 0; else if (d.data[i] > 200) d.data[i] = 255;
    x.putImageData(d, 0, 0);
    x.fillStyle = "#f30"; x.beginPath(); x.arc(w / 2, h / 2, Math.min(w, h) / 3, 0, 7); x.fill();
    return c.toDataURL();
  };
  const sizes = [[1000, 750], [333, 517], [2049, 1023], [512, 512]];
  const imgs = [];
  for (const [w, h] of sizes) { const im = new Image(); im.src = art(w, h); await im.decode(); imgs.push(im); }
  // handed to the worker as the app does: a 1:1 copy on an OffscreenCanvas
  const bitmaps = imgs.map((im) => { const oc = new OffscreenCanvas(im.naturalWidth, im.naturalHeight); oc.getContext("2d").drawImage(im, 0, 0); return oc.transferToImageBitmap(); });
  // cc::MipMapUtil: sizes round up; the last level not smaller than the target
  const axis = (s, l) => l === 0 ? s : Math.max(1, (s + (1 << l) - 1) >> l);
  const levelFor = (w, h, tw, th) => { for (let l = 0; ; l++) { const mw = axis(w, l), mh = axis(h, l); if (axis(h, l + 1) < th || axis(w, l + 1) < tw) return l; if (mw === 1 && mh === 1) return l; } };
  // levels made as the app makes them: the <img> drawn at the level's size
  const levelCache = {};
  const makeLevel = (i, r, l) => {
    const k = i + "|" + r.join(",") + "|" + l;
    if (!levelCache[k]) {
      const [sx, sy, sw, sh] = r;
      const oc = new OffscreenCanvas(axis(sw, l), axis(sh, l));
      const x = oc.getContext("2d"); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "low";
      x.drawImage(imgs[i], sx, sy, sw, sh, 0, 0, oc.width, oc.height);
      levelCache[k] = oc.transferToImageBitmap();
    }
    return levelCache[k];
  };
  const src = `
    const axis = (s, l) => l === 0 ? s : Math.max(1, (s + (1 << l) - 1) >> l);
    const levelFor = (w, h, tw, th) => { for (let l = 0; ; l++) { const mw = axis(w, l), mh = axis(h, l); if (axis(h, l + 1) < th || axis(w, l + 1) < tw) return l; if (mw === 1 && mh === 1) return l; } };
    let bitmaps;
    onmessage = async (e) => {
      const m = e.data;
      if (m.bitmaps) { bitmaps = m.bitmaps; postMessage(1); return; }
      const res = [];
      for (const t of m.cases) {
        const c = new OffscreenCanvas(952, 952); const x = c.getContext("2d");
        x.fillStyle = "#2A2F3A"; x.fillRect(0, 0, 952, 952);
        x.save(); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "low";
        x.setTransform(...t.m);
        const b = bitmaps[t.i];
        const [sx, sy, sw, sh] = t.r;
        const k1 = Math.hypot(t.m[0], t.m[1]), k2 = Math.hypot(t.m[2], t.m[3]);
        const l = levelFor(sw, sh, Math.round(sw * k1), Math.round(sh * k2));
        if (l === 0) x.drawImage(b, sx, sy, sw, sh, sx, sy, sw, sh);
        else {
          const p = t.level;
          // cc's src rect for a level: scaled by float32(level size / rect size)
          const ax = Math.fround(p.width / sw), ay = Math.fround(p.height / sh);
          x.drawImage(p, 0, 0, Math.fround(sw * ax), Math.fround(sh * ay), sx, sy, sw, sh);
        }
        x.restore();
        res.push(x.getImageData(0, 0, 952, 952).data.buffer);
      }
      postMessage(res, res);
    };`;
  const worker = new Worker(URL.createObjectURL(new Blob([src])));
  const ask = (msg, tr = []) => new Promise((r) => { worker.onmessage = (e) => r(e.data); worker.postMessage(msg, tr); });
  await ask({ bitmaps }, bitmaps);
  const cases = [];
  sizes.forEach(([w, h], i) => {
    for (const d of [0.2, 0.33, 0.45, 0.5, 0.6, 1.3]) for (const deg of [0, 23]) for (const r of [[0, 0, w, h], [Math.floor(w * 0.13), Math.floor(h * 0.21), Math.floor(w * 0.61), Math.floor(h * 0.57)]]) {
      const a = (deg * Math.PI) / 180, sxk = d, syk = d * 0.83;
      cases.push({ i, d, deg, r, m: [sxk * Math.cos(a), sxk * Math.sin(a), -syk * Math.sin(a), syk * Math.cos(a), 300.31, 200.77] });
    }
  });
  for (const t of cases) {
    const [, , sw, sh] = t.r;
    const k1 = Math.hypot(t.m[0], t.m[1]), k2 = Math.hypot(t.m[2], t.m[3]);
    const l = levelFor(sw, sh, Math.round(sw * k1), Math.round(sh * k2));
    t.level = l > 0 ? makeLevel(t.i, t.r, l) : null;
  }
  // the page's own draws: the decoded <img>, "high" as the compositor asks
  const main = cases.map((t) => {
    const c = document.createElement("canvas"); c.width = c.height = 952; const x = c.getContext("2d");
    x.fillStyle = "#2A2F3A"; x.fillRect(0, 0, 952, 952);
    x.save(); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
    x.setTransform(...t.m);
    const [sx, sy, sw, sh] = t.r;
    x.drawImage(imgs[t.i], sx, sy, sw, sh, sx, sy, sw, sh);
    x.restore();
    return x.getImageData(0, 0, 952, 952).data;
  });
  const res = await ask({ cases }, [...new Set(cases.map((t) => t.level).filter(Boolean))]);
  return cases.map((t, k) => {
    const a = main[k], b = new Uint8ClampedArray(res[k]);
    let n = 0, mx = 0;
    for (let j = 0; j < a.length; j++) { const q = Math.abs(a[j] - b[j]); if (q) { n++; mx = Math.max(mx, q); } }
    return { label: `${sizes[t.i].join("x").padEnd(10)} density ${String(t.d).padEnd(4)} (y ×0.83) rot ${String(t.deg).padStart(2)} ${t.r[2] === sizes[t.i][0] ? "whole  " : "subrect"}`, n, mx };
  });
});
await browser.close();

const identical = out.filter((c) => !c.n).length;
console.log(`decoded images on this browser's canvases take the ${imagePath.toUpperCase()} path${gpu ? " (GPU raster requested)" : ""}`);
for (const c of out.filter((c) => c.n)) console.log(`  ${c.label}: ${c.n} bytes differ, max ${c.mx}`);
console.log(`${identical} of ${out.length} cases identical (page <img> vs worker ImageBitmap with emulated mip levels)`);
if (imagePath === "cpu" && identical !== out.length) {
  console.log("CONTRACT BROKEN: the stage worker no longer draws decoded images exactly as the page does. See stage/geometry.ts.");
  process.exitCode = 1;
} else if (imagePath === "gpu") {
  console.log("GPU path: the app draws ImageBitmaps with the requested quality instead (exact above half size; approximate below, a known limitation).");
}
