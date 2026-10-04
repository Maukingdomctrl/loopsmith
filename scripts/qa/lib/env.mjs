// Browser and page setup shared by every QA script: which Chromium to drive,
// the rendering path under test, and the page set-up that makes runs
// reproducible byte for byte.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

/**
 * Rendering paths the pipeline can put the app on.
 *   cpu           default: CPU raster, software compositing (headless)
 *   gpu           GPU raster through SwiftShader (approximates a GPU machine)
 *   fallback      no transferControlToOffscreen: the stage is drawn on the page
 *   no-offscreen  no OffscreenCanvas at all (Safari before 16.4)
 */
export const PATHS = ["cpu", "gpu", "fallback", "no-offscreen"];

const GPU_ARGS = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-gpu-rasterization", "--ignore-gpu-blocklist"];
const BASE_ARGS = ["--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows"];

/** The newest Chromium in a Playwright browsers folder, if any. */
function playwrightChromium(root) {
  if (!root || !fs.existsSync(root)) return null;
  const exe = { linux: ["chrome-linux", "chrome"], darwin: ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"], win32: ["chrome-win", "chrome.exe"] }[process.platform];
  if (!exe) return null;
  const dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const d of dirs) {
    const p = path.join(root, d, ...exe);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** Which browser to drive: CHROME_PATH, else Playwright's Chromium (cloud
 *  sessions have one in PLAYWRIGHT_BROWSERS_PATH), else installed Chrome. */
export function browserTarget() {
  if (process.env.CHROME_PATH) return { executablePath: process.env.CHROME_PATH };
  try {
    const own = chromium.executablePath();
    if (own && fs.existsSync(own)) return { executablePath: own };
  } catch { /* no bundled revision */ }
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "ms-playwright"),
  ];
  for (const root of caches) {
    const p = playwrightChromium(root);
    if (p) return { executablePath: p };
  }
  return { channel: "chrome" };
}

export async function launch({ gpu = false } = {}) {
  return chromium.launch({ ...browserTarget(), headless: true, args: [...BASE_ARGS, ...(gpu ? GPU_ARGS : [])] });
}

/** The "x.y.z.w" version of the browser that will be driven. */
export async function browserVersion() {
  const b = await launch();
  try { return b.version(); } finally { await b.close(); }
}

/**
 * A page set up for reproducible drawing:
 *  - pointer timestamps snapped onto the 240 Hz grid they were sent on
 *    (Chromium jitters event.timeStamp per process, and pressure smoothing
 *    reads time, so identical input would otherwise draw different pixels);
 *  - Math.random, crypto.randomUUID and Date.now pinned (layer ids embed the
 *    time and seed the pencil's paper grain; the app uses Date.now for ids
 *    and timestamps only);
 *  - the rendering path restricted as asked (fallback, no-offscreen).
 */
export async function newPage(browser, { width = 1600, height = 848, dpr = 2, renderPath = "cpu", hz = 240 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
  await page.addInitScript(() => {
    let s = 12345;
    Math.random = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
    crypto.randomUUID = () => "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
    Date.now = () => 1700000000000;
  });
  await page.addInitScript((hz) => {
    const P = 1000 / hz;
    const desc = Object.getOwnPropertyDescriptor(Event.prototype, "timeStamp");
    let t0 = null;
    Object.defineProperty(Event.prototype, "timeStamp", {
      configurable: true,
      get() {
        const raw = desc.get.call(this);
        if (!(this instanceof MouseEvent)) return raw;
        if (this.type === "pointerdown" || t0 === null) t0 = raw;
        return 10000 + Math.round((raw - t0) / P) * P;
      },
    });
  }, hz);
  if (renderPath === "fallback" || renderPath === "no-offscreen") {
    await page.addInitScript(() => { delete HTMLCanvasElement.prototype.transferControlToOffscreen; });
  }
  if (renderPath === "no-offscreen") {
    await page.addInitScript(() => { delete globalThis.OffscreenCanvas; delete globalThis.OffscreenCanvasRenderingContext2D; });
  }
  return { context, page, errors };
}

/** Command-line options: `--name value` or a bare `--flag`. */
export function options(argv = process.argv.slice(2)) {
  return (name, def) => {
    const i = argv.indexOf(`--${name}`);
    if (i < 0) return def;
    const v = argv[i + 1];
    return v === undefined || v.startsWith("--") ? true : v;
  };
}
