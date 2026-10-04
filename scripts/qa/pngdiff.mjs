// How two captures differ, pixel by pixel, and (with --viz) a side-by-side
// crop for looking at it: A | B | difference × 40, scaled up.
//
//   node scripts/qa/pngdiff.mjs a.png b.png [c.png d.png …]
//   node scripts/qa/pngdiff.mjs a.png b.png --viz out.png [--box x,y,w,h] [--scale 3]
import fs from "node:fs";
import { launch, options } from "./lib/env.mjs";
import { describeDiff, pixelDiff } from "./lib/png.mjs";

const args = process.argv.slice(2);
const opt = options(args);
const files = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && ["--viz", "--box", "--scale"].includes(args[i - 1])));
const browser = await launch();
const page = await (await browser.newContext()).newPage();
await page.goto("about:blank");

for (let i = 0; i + 1 < files.length; i += 2) {
  const d = await pixelDiff(page, files[i], files[i + 1]);
  console.log(`${files[i]} vs ${files[i + 1]}: ${describeDiff(d)}`);
  if (d.pixels) console.log(`  spread: ${Object.entries(d.buckets).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
}

const viz = opt("viz", null);
if (viz && files.length >= 2) {
  const box = String(opt("box", "")).split(",").filter(Boolean).map(Number);
  const scale = Number(opt("scale", 3));
  const data = await page.evaluate(async ([a, b, box, k]) => {
    const load = async (s) => {
      const im = new Image(); im.src = "data:image/png;base64," + s; await im.decode();
      const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
      const g = c.getContext("2d"); g.drawImage(im, 0, 0);
      return c;
    };
    const ca = await load(a), cb = await load(b);
    const [x, y, w, h] = box.length === 4 ? box : [0, 0, ca.width, ca.height];
    const A = ca.getContext("2d").getImageData(x, y, w, h), B = cb.getContext("2d").getImageData(x, y, w, h);
    const D = new ImageData(w, h);
    for (let i = 0; i < A.data.length; i += 4) {
      let d = 0;
      for (let j = 0; j < 4; j++) d = Math.max(d, Math.abs(A.data[i + j] - B.data[i + j]));
      D.data[i] = Math.min(255, d * 40); D.data[i + 3] = 255;
    }
    const out = document.createElement("canvas");
    out.width = w * 3 * k + 8; out.height = h * k;
    const g = out.getContext("2d");
    g.imageSmoothingEnabled = false;
    g.fillStyle = "#fff"; g.fillRect(0, 0, out.width, out.height);
    [A, B, D].forEach((img, n) => {
      const t = document.createElement("canvas"); t.width = w; t.height = h;
      t.getContext("2d").putImageData(img, 0, 0);
      g.drawImage(t, n * (w * k + 4), 0, w * k, h * k);
    });
    return out.toDataURL().split(",")[1];
  }, [fs.readFileSync(files[0]).toString("base64"), fs.readFileSync(files[1]).toString("base64"), box, scale]);
  fs.writeFileSync(viz, Buffer.from(data, "base64"));
  console.log(`side by side (A | B | difference × 40): ${viz}`);
}
await browser.close();
