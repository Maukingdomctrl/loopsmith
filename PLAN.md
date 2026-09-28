# Loopsmith — Drawing Tools Plan

Goal: drawing in Loopsmith should look and feel like real pencils and a real rubber,
and must work on a blank canvas — not only on imported art.

Work through the steps **in order, one per session**. Each step ends with
`npm run build` passing and a quick manual test. Follow `CLAUDE.md` (small changes,
don't touch `lib/lsa`, all tools edit base-layer pixels).

---

## Step 1 — Blank canvas (do this first; everything else depends on it)

**Problem.** With nothing imported, the paint tools do nothing and their buttons are
disabled. Causes in `src/components/Canvas.tsx`:
- tool buttons use `disabled={isPlaying || !hasPixels}`;
- the surface effect bails out with `if (!base?.image ...)`, so no `RasterSurface` is ever
  created for an empty base layer (its size is 0×0).

There is also no way to start a project as a blank drawing canvas.

**Do.**
1. When a tool is picked and the base layer has no image, create a transparent
   **512×512** surface (`new RasterSurface(512, 512)`), and on first commit give the base
   layer `size {w:512,h:512}` and `pose = defaultFitPose(512, 512)`.
2. Remove `!hasPixels` from the tool buttons' `disabled`.
3. Replace "Double-click to import PNG" with two choices on an empty canvas:
   **Start drawing** (picks the Pencil) and **Import image**.
4. "New Animation" in the Projects drawer creates a blank project that is ready to draw on.

**Test.** New Animation → pick pencil → draw → undo → add frame → draw → export GIF.
New blank frames must be 512×512 so Auto Stabilize doesn't reject mismatched sizes.

---

## Step 2 — One clean cursor (fix the "two crosshairs")

**Problem.** While drawing, two crosshairs show: the browser's own cursor
(`cursor-crosshair` CSS class on the canvas, `Canvas.tsx` ~line 1453) **plus** the SVG
`BrushCursor` (which also draws a crosshair when the brush is small).

**Do.**
1. When a paint tool is active, use `cursor-none` on the canvas so only `BrushCursor` shows.
2. `BrushCursor` for pencils: a thin outline circle of the real tip size + a 1px centre dot.
   No crosshair arms. For the eraser: a soft rounded-rectangle outline (rubber shape).
3. Cursor ring shrinks/grows with live pen pressure (pass `pressure` prop from the pointer event).

**Test.** Draw with mouse and with pen: exactly one indicator, sitting exactly under the tip.

---

## Step 3 — Pencils that feel like pencils

Replace the single "Brush" with **3 pencils**, chosen from a small row in the paint toolbar:

| Pencil | Feel | Settings (starting point) |
|---|---|---|
| **HB** | light, thin, crisp — sketching | radius 1.2 px · hardness 0.9 · opacity 0.55 · grain strong |
| **2B** | medium dark — clean lines | radius 1.8 px · hardness 0.8 · opacity 0.8 · grain medium |
| **6B / Charcoal** | dark, soft, slightly wide — shading | radius 3.5 px · hardness 0.45 · opacity 0.95 · grain strong |

**What makes it feel like graphite:**
1. **Paper grain.** Add a deterministic grain texture in `lib/raster` (tileable value noise,
   seeded, e.g. 64×64). Multiply each stamp's coverage by `mix(1, grain(x,y), grainAmount)`
   in **surface/layer space**, so repeated strokes build up in the same paper tooth.
   Must stay deterministic (content hash feeds stabilization).
2. **Pressure → darkness first, size second.** Light touch = pale and thin, press = dark.
   Use `flowByPressure` (≈0.2→1) as the main effect, `sizeByPressure` gently (≈0.7→1).
3. **Build-up.** Use `accumulation: "buildup"` so going over a line again darkens it,
   like real graphite — but cap with opacity so it never becomes flat black.
4. **Smoothing.** `smoothing ≈ 0.25` (responsive, no lag).
5. Colour stays the chosen colour (default graphite grey `#2b2b2b`), so coloured pencils
   work for free.

**Test.** Light and hard lines with a pen; overlapping strokes darken; grain visible when
zoomed in; undo = one stroke.

---

## Step 4 — Rubber that feels like a real eraser

**Do.**
1. Eraser settings: hardness ≈ 0.6 (soft edge), `accumulation: "buildup"`,
   strength ≈ 0.5 per pass, so **one pass lightens, rubbing clears** — like a real rubber.
2. **Pressure → strength**: light touch lifts a little, hard press removes fully.
3. Apply the same paper grain lightly, so erasing graphite leaves a natural, slightly
   uneven edge rather than a perfect digital hole.
4. Two sizes on the toolbar: **fine** (detail) and **block** (large areas); size slider stays.
5. Cursor: soft rounded rectangle (from Step 2).

**Test.** Rub over a 6B stroke: fades gradually, clears fully with repeated passes, no
halo left behind.

---

## Step 5 — Tidy the paint toolbar

Final toolbar (top-left of the canvas, compact):
`HB · 2B · 6B` | `Rubber` | `Fill` | `Picker` | colour dot | size (only for pencil/rubber)

- Remember last used pencil, size and colour (per session).
- Shortcuts: `P` cycles pencils, `E` rubber, `G` fill, `I` picker, `Esc` puts the tool away,
  `[` / `]` size down/up.
- Remove the old "Eraser brush" switch in the right panel once the rubber is in the toolbar.

---

## Out of scope for this plan
Layers UI, shapes, WebP/APNG export — separate plans later.
