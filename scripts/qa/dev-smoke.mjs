// Development server smoke test. React Strict Mode mounts the stage canvas
// twice, and a canvas can be handed to a worker only once: the stage must
// still draw, previews and commits must show, and nothing may be logged.
//
//   node scripts/qa/dev-smoke.mjs --url http://localhost:3000   (a `next dev` server)
import { launch, newPage, options } from "./lib/env.mjs";
import { captureCanvas, stageInfo, startDrawing } from "./lib/app.mjs";

const opt = options();
const browser = await launch();
const { context, page, errors } = await newPage(browser);
page.on("console", (m) => { if (m.type() === "warning") errors.push(`console.warn: ${m.text().slice(0, 200)}`); });
await page.goto(String(opt("url", "http://localhost:3000/")), { waitUntil: "networkidle", timeout: 180000 });
await page.waitForTimeout(3000);
await startDrawing(page);
await page.waitForTimeout(800);

const changed = async (base) => page.evaluate(async ([url, base]) => {
  const px = async (u) => {
    const im = new Image(); im.src = u; await im.decode();
    const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
    const x = c.getContext("2d"); x.drawImage(im, 0, 0);
    return x.getImageData(0, 0, c.width, c.height).data;
  };
  const a = await px(url), b = await px(base);
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  return n;
}, [await captureCanvas(page), base]);

const blank = await captureCanvas(page);
const stage = await stageInfo(page);
const cdp = await context.newCDPSession(page);
const t0 = Date.now() / 1000;
for (let i = 0; i < 60; i++) {
  const type = i === 0 ? "mousePressed" : i === 59 ? "mouseReleased" : "mouseMoved";
  await cdp.send("Input.dispatchMouseEvent", {
    type, x: stage.x + stage.w * (0.3 + i * 0.006), y: stage.y + stage.h * (0.5 + Math.sin(i / 6) * 0.15),
    button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "pen", force: 0.7, timestamp: t0 + i / 240,
  });
}
await page.waitForTimeout(1200);
const after = await changed(blank);
const workers = await page.evaluate(() => performance.getEntriesByType("resource").filter((r) => /stage.worker|stage_worker/.test(r.name)).length);
await browser.close();

console.log(`stage drawn by: ${stage.drawnBy}; stage workers loaded: ${workers}; pixels changed by the stroke: ${after}`);
for (const e of errors) console.log(e);
const ok = stage.drawnBy && after > 0 && !errors.length && (stage.drawnBy !== "worker" || workers === 1);
console.log(ok ? "dev smoke: ok" : "dev smoke: FAILED");
process.exitCode = ok ? 0 : 1;
