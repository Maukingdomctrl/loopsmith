// The editing scenario suite: drives the app through the features a renderer
// change can break and captures the stage (and the onion skin) after every
// step, so two builds can be compared byte for byte.
//
//   node scripts/qa/scenarios.mjs --url http://localhost:3000 --out out/scenarios [--path cpu] [--only pencil,layers]
//
// Sessions: pencil (pencil, eraser, undo/redo, view zoom: stand-in then
// refine), brushes (Soft Round, Water, shapes, fill, eyedropper), layers
// (blend mode, opacity, clipping, layer mask painted by brush and pencil,
// adjustment layer), frames (second frame, onion skin, window resize),
// import-big / import-pow2 / import-medium (large images at several zooms:
// decoded-image resampling and mip levels), presets (the Marker and the
// Eraser brush: preset dynamics on the shared engine; skipped by a build
// that has neither).
//
// Writes one PNG per capture, values.json (the eyedropper's colour) and
// summary.json (per session: captures, who drew the stage, failures, page
// errors). Exits 1 if a session failed or the page logged an error.
import fs from "node:fs";
import path from "node:path";
import { launch, newPage, options } from "./lib/env.mjs";
import { captureCanvas, hasBrush, openApp, pickBrush, pngBytes, stageInfo, startDrawing, twoFrames } from "./lib/app.mjs";

const opt = options();
const URL_ = String(opt("url", "http://localhost:3000/"));
const OUT = String(opt("out", "out/scenarios"));
const RENDER_PATH = String(opt("path", opt("gpu", "cpu") === "swiftshader" ? "gpu" : opt("no-offscreen", false) ? "no-offscreen" : opt("fallback", false) ? "fallback" : "cpu"));
const ONLY = opt("only", null) ? String(opt("only")).split(",") : null;
const DPR = Number(opt("dpr", 2));
const DUMP = !!opt("dump", false);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const browser = await launch({ gpu: RENDER_PATH === "gpu" });
const values = {};
const summary = {};
const log = (...a) => console.log(...a);

async function session(name, fn) {
  if (ONLY && !ONLY.some((o) => name.includes(o))) return;
  const { context, page, errors } = await newPage(browser, { width: 1600, height: 848, dpr: DPR, renderPath: RENDER_PATH });
  await openApp(page, URL_);
  const cdp = await context.newCDPSession(page);
  let n = 0;
  const h = {
    page,
    async settle(ms = 500) {
      await page.waitForTimeout(ms);
      await twoFrames(page);
      await page.waitForTimeout(60);
    },
    async stage() {
      return stageInfo(page);
    },
    async capture(label, { onion = false } = {}) {
      const file = `${name}-${String(++n).padStart(2, "0")}-${label}.png`;
      fs.writeFileSync(path.join(OUT, file), pngBytes(await captureCanvas(page, { onion })));
      if (DUMP) fs.appendFileSync(path.join(OUT, "state.txt"), `${file}\n  ${(await documentState(page)).join("\n  ")}\n`);
    },
    /** A pen stroke: a loop around (cx, cy) in stage fractions; captures before pen-up. */
    async penStroke(label, cx, cy, r, { events = 90, pointerType = "pen", capture = true } = {}) {
      const s = await h.stage();
      const t0 = Date.now() / 1000;
      const pt = (i) => {
        const u = i / (events - 1);
        const a = u * Math.PI * 2 * 1.1;
        return {
          x: s.x + s.w * (cx + r * Math.sin(a) * (0.7 + 0.3 * Math.cos(u * 3))),
          y: s.y + s.h * (cy + r * 0.8 * Math.sin(2 * a)),
          p: 0.3 + 0.6 * (0.5 + 0.5 * Math.sin(u * 7)),
        };
      };
      const send = (type, p, i) => cdp.send("Input.dispatchMouseEvent", {
        type, x: p.x, y: p.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1,
        pointerType, force: type === "mouseReleased" ? 0 : p.p, tiltX: 0, tiltY: 0, twist: 0, timestamp: t0 + i / 240,
      });
      await send("mousePressed", pt(0), 0);
      for (let i = 1; i < events - 1; i++) await send("mouseMoved", pt(i), i);
      if (capture) {
        await twoFrames(page);
        await page.waitForTimeout(80);
        await h.capture(`${label}-live`);
      }
      await send("mouseReleased", pt(events - 1), events - 1);
      await h.settle(700);
      await h.capture(`${label}-done`);
    },
    /** A mouse drag from (x0, y0) to (x1, y1), stage fractions; captures mid-drag. */
    async drag(label, x0, y0, x1, y1, steps = 12) {
      const s = await h.stage();
      const at = (u) => ({ x: s.x + s.w * (x0 + (x1 - x0) * u), y: s.y + s.h * (y0 + (y1 - y0) * u) });
      const t0 = Date.now() / 1000;
      const send = (type, p, i) => cdp.send("Input.dispatchMouseEvent", {
        type, x: p.x, y: p.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "mouse", timestamp: t0 + i / 240,
      });
      await send("mousePressed", at(0), 0);
      for (let i = 1; i <= steps; i++) await send("mouseMoved", at(i / steps), i);
      await twoFrames(page);
      await page.waitForTimeout(80);
      await h.capture(`${label}-live`);
      await send("mouseReleased", at(1), steps + 1);
      await h.settle(700);
      await h.capture(`${label}-done`);
    },
    async click(fx, fy) {
      const s = await h.stage();
      const p = { x: s.x + s.w * fx, y: s.y + s.h * fy };
      for (const type of ["mousePressed", "mouseReleased"]) {
        await cdp.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1, pointerType: "mouse" });
      }
    },
    async key(k) {
      await page.keyboard.press(k);
      await page.waitForTimeout(150);
    },
    brush: (id) => pickBrush(page, id),
    async importImage(w, h_, seed) {
      const b64 = await page.evaluate(([w, h, seed]) => {
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        const x = c.getContext("2d");
        const g = x.createLinearGradient(0, 0, w, h);
        g.addColorStop(0, "rgba(255,60,0,1)"); g.addColorStop(0.5, "rgba(20,180,90,0.6)"); g.addColorStop(1, "rgba(0,40,255,0.9)");
        x.fillStyle = g; x.fillRect(w * 0.04, h * 0.04, w * 0.92, h * 0.92);
        x.strokeStyle = "#000"; x.lineWidth = Math.max(1, w / 300);
        for (let i = 0; i < 40; i++) { x.beginPath(); x.arc(w / 2, h / 2, (Math.min(w, h) / 90) * (i + 1), i * 0.3, i * 0.3 + 4.5); x.stroke(); }
        const d = x.getImageData(0, 0, w, h);
        let s = seed;
        for (let i = 0; i < d.data.length; i += 4) { s = (s * 1103515245 + 12345) >>> 0; if ((s >>> 24) < 30) d.data[i + 3] = (s >>> 16) & 255; }
        x.putImageData(d, 0, 0);
        return c.toDataURL("image/png").split(",")[1];
      }, [w, h_, seed]);
      await page.setInputFiles('input[type="file"]', { name: "art.png", mimeType: "image/png", buffer: Buffer.from(b64, "base64") });
      await h.settle(1500);
    },
  };
  const result = { captures: 0, drawnBy: null, failed: null, errors };
  try {
    await fn(h);
    result.drawnBy = (await stageInfo(page))?.drawnBy ?? null;
  } catch (e) {
    result.failed = e.message.split("\n")[0];
    log(`${name}: FAILED ${result.failed}`);
  }
  result.captures = n;
  summary[name] = result;
  if (errors.length) log(`${name}: page errors: ${errors.slice(0, 5).join(" | ")}`);
  log(`${name}: ${n} captures, stage drawn by ${result.drawnBy ?? "?"}`);
  await context.close();
}

/** The document as stored (IndexedDB): each layer's pixels, mask and strokes, hashed. */
function documentState(page) {
  return page.evaluate(async () => {
    const hash = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); };
    const rows = [];
    for (const d of await indexedDB.databases()) {
      const db = await new Promise((r, j) => { const q = indexedDB.open(d.name); q.onsuccess = () => r(q.result); q.onerror = j; });
      for (const store of db.objectStoreNames) {
        const all = await new Promise((r) => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => r(q.result); });
        JSON.stringify(all, (k, v) => {
          if (v && typeof v === "object" && typeof v.kind === "string" && v.pose) {
            rows.push(`${v.kind}:${v.name} img=${v.image ? hash(v.image) : "-"} mask=${v.mask?.image ? hash(v.mask.image) : "-"} strokes=${v.strokes?.length ?? 0} blend=${v.blend} op=${v.opacity} clip=${!!v.clip}`);
          }
          return v;
        });
      }
    }
    return rows;
  });
}

/* ---------------- scenarios ---------------- */

await session("pencil", async (h) => {
  await startDrawing(h.page);
  await h.settle(400);
  await h.penStroke("pencil1", 0.45, 0.45, 0.22);
  await h.penStroke("pencil2", 0.55, 0.5, 0.18);
  await h.key("e");
  await h.penStroke("eraser", 0.5, 0.48, 0.15);
  await h.key("Control+z");
  await h.settle(500);
  await h.capture("undo");
  await h.key("Control+Shift+z");
  await h.settle(500);
  await h.capture("redo");
  // view zoom changes the pencil layer's matrix: stand-in, then exact render
  await h.page.getByRole("button", { name: /^Zoom out/ }).first().click();
  await h.settle(900);
  await h.capture("zoomed-out");
  await h.page.getByRole("button", { name: /^Zoom in/ }).first().click();
  await h.page.getByRole("button", { name: /^Zoom in/ }).first().click();
  await h.settle(900);
  await h.capture("zoomed-in");
});

await session("brushes", async (h) => {
  await startDrawing(h.page);
  await h.settle(400);
  await h.brush("softRound");
  await h.penStroke("softround", 0.4, 0.4, 0.2);
  await h.brush("water");
  await h.penStroke("water", 0.6, 0.55, 0.2);
  // shapes, then fill inside one
  await h.key("u");
  await h.drag("rect", 0.2, 0.62, 0.45, 0.85);
  await h.key("g");
  await h.click(0.33, 0.74);
  await h.settle(700);
  await h.capture("fill");
  // eyedropper on the filled shape
  await h.key("i");
  await h.click(0.3, 0.7);
  await h.settle(400);
  values.eyedropper = await h.page.$eval('input[aria-label="Current colour"]', (e) => e.value);
  await h.capture("picked");
  // a pencil stroke with the picked colour (the picker switches to the pencil)
  await h.penStroke("pickedpencil", 0.7, 0.3, 0.12);
});

await session("layers", async (h) => {
  await startDrawing(h.page);
  await h.settle(400);
  await h.brush("hardLine");
  await h.penStroke("base", 0.45, 0.45, 0.25);
  await h.page.getByRole("button", { name: "New layer" }).click();
  await h.page.getByText("Blank layer", { exact: true }).click();
  await h.settle(400);
  await h.brush("softRect");
  await h.penStroke("layer2", 0.55, 0.5, 0.22);
  await h.page.selectOption('select[aria-label="Blend mode"]', "multiply");
  await h.settle(500);
  await h.capture("multiply");
  await h.page.fill('input[aria-label="Layer opacity"]', "55");
  await h.settle(500);
  await h.capture("opacity");
  // brush on a layer with a blend mode (isolated draw path)
  await h.penStroke("blended", 0.35, 0.6, 0.15);
  await h.page.getByTitle("Clipping mask: show this layer only where the layer below has pixels").click();
  await h.settle(500);
  await h.capture("clipped");
  await h.penStroke("clippedbrush", 0.6, 0.35, 0.15);
  // a mask on the layer: paint on it with the brush and the pencil
  await h.page.getByTitle("Add layer mask (Alt-click: a mask that hides everything)").click();
  await h.settle(400);
  await h.page.getByRole("button", { name: /Paint on .* mask/ }).first().click();
  await h.settle(400);
  await h.brush("softRound");
  await h.penStroke("maskbrush", 0.5, 0.5, 0.2);
  await h.key("p");
  await h.penStroke("maskpencil", 0.45, 0.4, 0.15);
  await h.key("Control+z");
  await h.settle(500);
  await h.capture("undo");
  // an adjustment layer over everything (the stack is built on its own surface)
  await h.page.getByRole("button", { name: "New layer" }).click();
  await h.page.getByText("Hue/Saturation", { exact: true }).click();
  await h.settle(600);
  await h.capture("adjust");
});

await session("frames", async (h) => {
  await startDrawing(h.page);
  await h.settle(400);
  await h.penStroke("frame1", 0.45, 0.45, 0.25, { capture: false });
  await h.page.getByRole("button", { name: "Add frame" }).click();
  await h.settle(900);
  await h.capture("frame2");
  await h.capture("onion", { onion: true });
  await h.key("p");
  await h.penStroke("frame2pencil", 0.55, 0.5, 0.2);
  await h.page.setViewportSize({ width: 1240, height: 720 });
  await h.settle(900);
  await h.capture("resized");
  await h.capture("resized-onion", { onion: true });
  await h.penStroke("resizedpencil", 0.4, 0.55, 0.15);
});

for (const [w, hh, label] of [[3000, 1700, "big"], [2048, 2048, "pow2"], [1100, 900, "medium"]]) {
  await session(`import-${label}`, async (h) => {
    await h.importImage(w, hh, 7);
    await h.capture("imported");
    await h.page.getByRole("button", { name: /^Zoom out/ }).first().click();
    await h.settle(700);
    await h.capture("zoomout");
    await h.page.getByRole("button", { name: /^Zoom in/ }).first().click();
    await h.page.getByRole("button", { name: /^Zoom in/ }).first().click();
    await h.page.getByRole("button", { name: /^Zoom in/ }).first().click();
    await h.settle(700);
    await h.capture("zoomin");
    await h.page.getByRole("button", { name: /^Zoom out/ }).first().click();
    await h.page.getByRole("button", { name: /^Zoom out/ }).first().click();
    await h.settle(700);
    await h.capture("back");
    await h.brush("hardLine");
    await h.penStroke("brush", 0.5, 0.5, 0.2);
    await h.key("p");
    await h.penStroke("pencil", 0.45, 0.4, 0.15);
  });
}

// Preset dynamics on the shared engine: a Marker over a soft wash, then the
// Eraser brush lifting a band through both. A build without these brushes
// (a base from before them) skips the session: there is nothing to compare.
await session("presets", async (h) => {
  await startDrawing(h.page);
  await h.settle(400);
  if (!(await hasBrush(h.page, "marker")) || !(await hasBrush(h.page, "eraser"))) {
    log("presets: this build has no Marker / Eraser brush — skipped");
    return;
  }
  await h.brush("softRound");
  await h.penStroke("wash", 0.45, 0.48, 0.22, { capture: false });
  await h.brush("marker");
  await h.penStroke("marker", 0.55, 0.5, 0.2);
  await h.brush("eraser");
  await h.penStroke("eraser", 0.5, 0.45, 0.16);
});

fs.writeFileSync(path.join(OUT, "values.json"), JSON.stringify(values, null, 1));
fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify({ path: RENDER_PATH, sessions: summary, values }, null, 1));
log("values:", JSON.stringify(values));
await browser.close();
const bad = Object.values(summary).some((s) => s.failed || s.errors.length);
process.exitCode = bad ? 1 : 0;
