// End-to-end drawing harness: one tool, a few strokes, measured and captured.
//
// Drives the production app in headless Chromium with CDP pen events (1 down,
// N-2 moves, 1 up) along a looping curve with varying pressure. Per stroke:
// main-thread time (the renderer's TaskDuration, no tracing overhead). On
// request: the stage's pixels (before pen-up and after the commit) and every
// PNG the app encodes, a multi-process trace and a V8 CPU profile of the last
// stroke, and per-call timings of the page's canvas calls.
//
//   node scripts/qa/stroke.mjs --url http://localhost:3000 --brush hardLine --pace await \
//        --pixels out/px --trace out/trace.json --cpuprofile out/cpu.json
//
// --brush    hardLine | softRound | softRect | water | texture | pencil
// --pace     await (one event per frame) | hz (real time, --hz 240)
// --path     cpu | gpu | fallback | no-offscreen   (see lib/env.mjs)
// --strokes  strokes to draw (the first is a warm-up in the summary), default 2
// --out      JSON with every stroke's numbers
import fs from "node:fs";
import path from "node:path";
import { launch, newPage, options } from "./lib/env.mjs";
import { BRUSHES, captureCanvas, openApp, pickBrush, pngBytes, stageInfo, startDrawing, twoFrames } from "./lib/app.mjs";
import { median } from "./lib/stats.mjs";

const opt = options();
const URL_ = String(opt("url", "http://localhost:3000/"));
const BRUSH = String(opt("brush", "hardLine"));
const PACE = String(opt("pace", "await"));
const HZ = Number(opt("hz", 240));
const EVENTS = Number(opt("events", 241));
const STROKES = Number(opt("strokes", 2));
const VW = Number(opt("vw", 1600)), VH = Number(opt("vh", 848));
const DPR = Number(opt("dpr", 2));
const TRACE = opt("trace", null);
const CPU = opt("cpuprofile", null);
const PIXELS = opt("pixels", null);
const WRAP = !!opt("wrap", false);
const SETTLE = Number(opt("settle", 1500));
const CPU_INTERVAL = Number(opt("cpuint", 50));
const RENDER_PATH = String(opt("path", opt("gpu", "cpu") === "swiftshader" ? "gpu" : opt("no-offscreen", false) ? "no-offscreen" : opt("fallback", false) ? "fallback" : "cpu"));
if (BRUSH !== "pencil" && !BRUSHES[BRUSH]) throw new Error(`--brush ${BRUSH}: use pencil or ${Object.keys(BRUSHES).join(", ")}`);

const browser = await launch({ gpu: RENDER_PATH === "gpu" });
const { context, page, errors } = await newPage(browser, { width: VW, height: VH, dpr: DPR, renderPath: RENDER_PATH, hz: HZ });

if (WRAP) {
  // Times the page's own canvas calls without touching the app: putImageData
  // (upload), drawImage (compositing), toDataURL (commit encode), and each
  // requestAnimationFrame callback as a whole.
  await page.addInitScript(() => {
    const acc = (window.__acc = {});
    const add = (k, dt) => { const a = (acc[k] ??= { n: 0, t: 0, max: 0 }); a.n++; a.t += dt; if (dt > a.max) a.max = dt; };
    const wrap = (proto, name, key) => {
      const f = proto[name];
      proto[name] = function (...a) {
        const t0 = performance.now();
        try { return f.apply(this, a); } finally { add(key ?? name, performance.now() - t0); }
      };
    };
    const C = CanvasRenderingContext2D.prototype;
    for (const name of ["putImageData", "drawImage", "getImageData", "clip", "clearRect", "fillRect"]) wrap(C, name);
    wrap(HTMLCanvasElement.prototype, "toDataURL");
    wrap(HTMLCanvasElement.prototype, "getContext");
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => raf((ts) => {
      const t0 = performance.now();
      try { cb(ts); } finally { add("rafCallback", performance.now() - t0); }
    });
    const IDC = window.ImageData;
    window.ImageData = new Proxy(IDC, { construct(T, a) { const t0 = performance.now(); try { return new T(...a); } finally { add("new ImageData", performance.now() - t0); } } });
  });
}
if (PIXELS) {
  // Every PNG the app encodes (the committed layer, the flattened frame).
  // Tiny canvases are the app's own probes, not commits.
  await page.addInitScript(() => {
    window.__pngs = [];
    const f = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...a) {
      const r = f.apply(this, a);
      if (!window.__qaCapturing && this.width >= 8) window.__pngs.push(`${this.width}x${this.height}|${r}`);
      return r;
    };
  });
}

await openApp(page, URL_);
await startDrawing(page);
if (BRUSH !== "pencil") await pickBrush(page, BRUSH);
if (opt("no-onion", false)) { await page.getByRole("button", { name: /Onion skin/ }).click(); await page.waitForTimeout(200); }
if (opt("hide-onion", false)) await page.evaluate(() => { const c = [...document.querySelectorAll("canvas")].find((c) => c.className.includes("opacity-30")); c.style.display = "none"; });
await page.waitForTimeout(600);

const stage = await stageInfo(page);
console.log(`stage drawn by: ${stage.drawnBy}`);
console.log(`stage: ${stage.w.toFixed(0)} CSS px at (${stage.x.toFixed(0)}, ${stage.y.toFixed(0)}), backing ${stage.backing} px, dpr ${DPR}, ${BRUSH}, pace ${PACE}${PACE === "hz" ? " " + HZ : ""}, path ${RENDER_PATH}`);

const cdp = await context.newCDPSession(page);

/** The gesture: a looping curve across the middle of the stage, pressure varying. */
function gesture(k) {
  const pts = [];
  const cx = stage.x + stage.w / 2, cy = stage.y + stage.h / 2;
  const R = stage.w * 0.3;
  for (let i = 0; i < EVENTS; i++) {
    const u = i / (EVENTS - 1);
    const a = u * Math.PI * 2 * 1.15 + k * 0.7;
    const x = cx + R * Math.sin(a) * (0.6 + 0.4 * Math.cos(u * 3)) + (k - 0.5) * 8;
    const y = cy + R * 0.75 * Math.sin(2 * a) + (k - 0.5) * 6;
    const pressure = 0.25 + 0.65 * (0.5 + 0.5 * Math.sin(u * Math.PI * 3 + k));
    pts.push({ x, y, pressure });
  }
  return pts;
}

async function readPixels(label, onion = false) {
  if (!PIXELS) return;
  fs.mkdirSync(PIXELS, { recursive: true });
  fs.writeFileSync(path.join(PIXELS, `${label}.png`), pngBytes(await captureCanvas(page, { onion })));
}

async function metrics() {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

async function stroke(k) {
  const pts = gesture(k);
  await cdp.send("Performance.enable", { timeDomain: "threadTicks" }).catch(() => {});
  const m0 = await metrics();
  const t0 = Date.now() / 1000;
  const send = (type, p, i) => cdp.send("Input.dispatchMouseEvent", {
    type, x: p.x, y: p.y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1,
    pointerType: "pen", force: type === "mouseReleased" ? 0 : p.pressure, tiltX: 0, tiltY: 0, twist: 0,
    timestamp: t0 + i / HZ,
  });
  const marks = {};
  marks.start = await page.evaluate(() => performance.now());
  if (PACE === "await") {
    await send("mousePressed", pts[0], 0);
    for (let i = 1; i < pts.length - 1; i++) await send("mouseMoved", pts[i], i);
    if (PIXELS) {
      // let the last preview land, then read the stage before pen-up
      await twoFrames(page);
      await readPixels(`stroke${k}-before-up`);
    }
    await send("mouseReleased", pts[pts.length - 1], pts.length - 1);
  } else {
    const period = 1000 / HZ;
    const begin = performance.now();
    const pending = [];
    for (let i = 0; i < pts.length; i++) {
      const due = begin + i * period;
      while (performance.now() < due) await new Promise((r) => setImmediate(r));
      const type = i === 0 ? "mousePressed" : i === pts.length - 1 ? "mouseReleased" : "mouseMoved";
      pending.push(send(type, pts[i], i));
    }
    await Promise.all(pending);
  }
  marks.upSent = await page.evaluate(() => performance.now());
  const mUp = await metrics();
  await page.waitForTimeout(SETTLE);
  await page.evaluate(() => new Promise((r) => requestIdleCallback(r, { timeout: 2000 })));
  marks.settled = await page.evaluate(() => performance.now());
  const m1 = await metrics();
  marks.task = (m1.TaskDuration - m0.TaskDuration) * 1000;
  marks.during = (mUp.TaskDuration - m0.TaskDuration) * 1000;
  marks.script = (m1.ScriptDuration - m0.ScriptDuration) * 1000;
  marks.style = (m1.RecalcStyleDuration - m0.RecalcStyleDuration) * 1000;
  marks.layout = (m1.LayoutDuration - m0.LayoutDuration) * 1000;
  await readPixels(`stroke${k}-after-commit`);
  if (PIXELS) {
    const pngs = await page.evaluate(() => window.__pngs.splice(0));
    pngs.forEach((p, j) => {
      const [size, url] = p.split("|");
      fs.writeFileSync(path.join(PIXELS, `stroke${k}-encoded${j}-${size}.png`), pngBytes(url));
    });
  }
  return marks;
}

const results = [];
if (opt("twoframes", false)) {
  // A second frame, so the onion skin shows the first one under the strokes.
  await stroke(7);
  await page.getByRole("button", { name: "Add frame" }).click();
  await page.waitForTimeout(800);
  if (PIXELS) {
    await readPixels("onion", true);
    await page.screenshot({ path: path.join(PIXELS, "screen-onion.png"), clip: { x: stage.x, y: stage.y, width: stage.w, height: stage.h } });
    await page.evaluate(() => window.__pngs.splice(0));
  }
}
for (let k = 0; k < STROKES; k++) {
  const last = k === STROKES - 1;
  if (WRAP) await page.evaluate(() => { for (const k of Object.keys(window.__acc)) delete window.__acc[k]; });
  if (last && TRACE) {
    await browser.startTracing(page, {
      categories: [
        "toplevel", "blink", "blink.user_timing", "cc", "gpu", "viz", "v8", "v8.execute", "input",
        "devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame",
        "disabled-by-default-v8.gc", "benchmark", "latencyInfo", "renderer.scheduler", "loading", "scheduler",
        "disabled-by-default-devtools.timeline.invalidationTracking", "skia",
      ],
    });
  }
  if (last && CPU) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: CPU_INTERVAL });
    await cdp.send("Profiler.start");
  }
  const m = await stroke(k);
  if (last && CPU) {
    const { profile } = await cdp.send("Profiler.stop");
    fs.mkdirSync(path.dirname(path.resolve(CPU)), { recursive: true });
    fs.writeFileSync(CPU, JSON.stringify(profile));
  }
  if (last && TRACE) {
    const buf = await browser.stopTracing();
    fs.mkdirSync(path.dirname(path.resolve(TRACE)), { recursive: true });
    fs.writeFileSync(TRACE, buf);
  }
  const acc = WRAP ? await page.evaluate(() => window.__acc) : null;
  results.push({ k, marks: m, acc });
  console.log(`stroke ${k}: dispatch ${(m.upSent - m.start).toFixed(0)} ms wall (down→up sent); main-thread TaskDuration ${m.task.toFixed(1)} ms (script ${m.script.toFixed(1)}, style ${m.style.toFixed(1)}, layout ${m.layout.toFixed(1)})`);
  if (acc) {
    for (const [name, a] of Object.entries(acc).sort((p, q) => q[1].t - p[1].t)) {
      console.log(`   ${name.padEnd(16)} n=${String(a.n).padStart(5)}  total ${a.t.toFixed(1).padStart(8)} ms  max ${a.max.toFixed(2)} ms`);
    }
  }
}

// The first stroke warms the app up; the summary is over the rest.
const warm = results.slice(STROKES > 1 ? 1 : 0);
const summary = warm.length ? {
  strokes: warm.length,
  mainThreadMs: median(warm.map((r) => r.marks.task)),
  downToUpMs: median(warm.map((r) => r.marks.during)),
  minMs: Math.min(...warm.map((r) => r.marks.task)),
  maxMs: Math.max(...warm.map((r) => r.marks.task)),
} : null;
if (summary) {
  console.log(`SUMMARY brush=${BRUSH} pace=${PACE} path=${RENDER_PATH} warm strokes=${summary.strokes} main-thread median ${summary.mainThreadMs.toFixed(1)} ms (down→up ${summary.downToUpMs.toFixed(1)}, after up ${(summary.mainThreadMs - summary.downToUpMs).toFixed(1)}), min ${summary.minMs.toFixed(1)}, max ${summary.maxMs.toFixed(1)}`);
}
for (const e of errors) console.log(e);
const out = opt("out", null);
if (out) {
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ brush: BRUSH, pace: PACE, path: RENDER_PATH, stage, results, summary, errors }, null, 1));
}
await browser.close();
