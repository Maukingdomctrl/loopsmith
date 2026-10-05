// Driving the Loopsmith editor: its stage canvas, tools and captures.

/** The stage canvas's class (it has no width/height attributes: the stage
 *  worker sizes it, so it is found by class). The onion skin also carries
 *  `opacity-30`. */
export const STAGE_CLASS = "absolute inset-0 h-full w-full";

export const BRUSHES = {
  hardLine: "Hard Linework",
  softRound: "Soft Round",
  softRect: "Soft Rectangle",
  water: "Water",
  texture: "Texture",
  marker: "Marker",
  eraser: "Eraser",
};

export async function openApp(page, url) {
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
}

/** A blank sheet with the pencil picked. */
export async function startDrawing(page) {
  await page.getByRole("button", { name: "Start drawing" }).click();
  await page.waitForTimeout(300);
}

/** Whether this build's brush panel offers a brush (a base built before a
 *  brush existed does not). Leaves the panel closed. */
export async function hasBrush(page, id) {
  const radio = page.getByRole("radio", { name: new RegExp(BRUSHES[id]) });
  for (let i = 0; i < 3 && !(await radio.count()); i++) {
    await page.getByRole("button", { name: "Brush (B)" }).click();
    await page.waitForTimeout(250);
  }
  const found = (await radio.count()) > 0;
  const close = page.getByRole("button", { name: "Close brush panel" });
  if (await close.count()) await close.click();
  await page.waitForTimeout(150);
  return found;
}

/** Pick a brush in the brush panel, then close the panel. */
export async function pickBrush(page, id) {
  const radio = page.getByRole("radio", { name: new RegExp(BRUSHES[id]) });
  for (let i = 0; i < 3 && !(await radio.isVisible()); i++) {
    await page.getByRole("button", { name: "Brush (B)" }).click();
    await page.waitForTimeout(250);
  }
  await radio.click();
  await page.waitForTimeout(150);
  const close = page.getByRole("button", { name: "Close brush panel" });
  if (await close.count()) await close.click();
  await page.waitForTimeout(200);
}

/** The stage's box on the page, and who draws it: a canvas handed to the
 *  stage worker refuses getContext. */
export async function stageInfo(page) {
  return page.evaluate((cls) => {
    const c = [...document.querySelectorAll("canvas")].find((c) => c.className === cls);
    if (!c) return null;
    const r = c.getBoundingClientRect();
    let drawnBy;
    try { drawnBy = c.getContext("2d") ? "page" : "?"; } catch { drawnBy = "worker"; }
    return { x: r.x, y: r.y, w: r.width, h: r.height, backing: c.width, drawnBy };
  }, STAGE_CLASS);
}

/** Two animation frames: whatever the page drew has been presented. */
export const twoFrames = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/**
 * The stage (or the onion skin) as a PNG data URL, once it has stopped
 * changing: a stage drawn by the worker reaches the page a frame or two
 * after the draw, and later still when the worker is busy.
 */
export async function captureCanvas(page, { onion = false, settleMs = 120, tries = 30 } = {}) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const url = await page.evaluate(([cls, onion]) => {
      const c = [...document.querySelectorAll("canvas")].find((c) =>
        onion ? c.className.includes("opacity-30") : c.className === cls);
      if (!c) return null;
      // The harness's own reads are not the app's encodes (see stroke.mjs).
      window.__qaCapturing = true;
      try { return c.toDataURL("image/png"); } finally { window.__qaCapturing = false; }
    }, [STAGE_CLASS, onion]);
    if (url !== null && url === last) return url;
    last = url;
    await page.waitForTimeout(settleMs);
  }
  return last;
}

export const pngBytes = (dataUrl) => Buffer.from(dataUrl.split(",")[1], "base64");
