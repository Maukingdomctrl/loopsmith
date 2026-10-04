# Loopsmith — notes for Claude

Next.js + TypeScript app that turns AI-generated spritesheets into clean animated emojis/GIFs.
Flow: **Import & cut → Studio (stabilize, background, touch-up) → Export**.

## Commands
- `npm run dev` — local app at http://localhost:3000
- `npm run build` — must pass (type check included) before any change is done
- `npm run qa` — brush-engine QA and performance pipeline for the change (skill `brush-qa`,
  `scripts/qa/README.md`): pixel-exact regression, worker/page parity, timing and latency vs `origin/main`

## Working style (the owner prefers this)
- Small, focused changes; one step at a time. Explain in plain words.
- Keep existing prop names and file structure; do not rewrite files wholesale unless asked.
- Don't add features or UI that weren't asked for. Less on screen is better.

## Do not break
- **Auto stabilize** works very well — do not modify `src/lib/lsa/**` or `src/hooks/useAutoStabilize.ts`.
- **Clean-edge cutting**: `extractCleanCells` in `src/lib/sprite/slice.ts` (used by `SpriteSheetCutter.tsx`)
  keeps only the sprite each cell owns (via `occupancy.ts` + `ownership.ts`). Keep it.
- **GIF export** (`src/lib/exportGif.ts`): smoothing on, hard alpha cutoff, black art nudged off the
  transparent key colour. Keep these.

## Architecture rules
- Frames hold layers; the **base layer** holds the artwork. Pose = position/scale/rotation (see `lib/layers/layerSpace.ts`).
- Canvas → layer pixel: invert `baseLayerMatrix(frame)` from `lib/frameTransform.ts` (includes stabilization offset).
- **Pencil & eraser store stroke physics, not pixels** (`lib/pencil`): each stroke is its samples
  (x, y, pressure, tilt, azimuth, twist, time) in base-layer space, kept in `layer.strokes`. The
  compositor (`lib/layers/composite.ts`) renders them analytically at every resolution (view,
  flatten, GIF) over the layer's `image`: spline + signed-distance edges, procedural paper
  (`paper.ts`), no stamps. Renders are cached; views show a stand-in while zooming, then refine.
- **Brush, fill and shapes work on pixels** (`lib/raster`: `RasterSurface`, `MaterialStroke`, `floodFill`, commit via
  `surface.commit()`, decoded before it is swapped in so the canvas never blinks). Before brush, fill or the
  lasso touch a layer, its pencil strokes are baked into `image` (`pencil/bake.ts`).
- **Brushes** (`lib/raster/brushes/`): one `MaterialStroke`, built on the existing `StrokePath`, drives five
  materials — soft round / soft rectangle, hard line, water, texture — picked in `components/BrushPanel.tsx`.
  A new brush is a `BrushSpec` in `presets.ts` plus a `BrushModel` in `models/`. Pressure only ever goes
  through the continuous curves in `curves.ts` (no thresholds); texture and noise are deterministic.
- **Clipping masks & adjustment layers** (`layer.clip`, `layer.adjust`): the compositor builds the stack on
  its own surface only when a frame has them (`compositeStack`), so other frames render exactly as before.
  Adjustment math is `lib/layers/adjust.ts`. Layers added "on every frame" share a `linkId`; the layer
  panel's blend, lock, clip, opacity and adjustment edits apply to every linked copy (`page.tsx`).
- **Layer masks** (`layer.mask`): greyscale PNG in layer space (white shows), or a solid fill when unpainted;
  `inverted` / `enabled` are flags. The compositor turns it into alpha (`layerMask`) and applies it with
  `destination-in`; adjustment layers use it as per-pixel strength. With the mask thumbnail picked
  (`editMask`), every paint tool paints greys into the mask through the pixel surface.
- **Layer groups** (`lib/layers/groups.ts`): a `kind: "group"` entry in the layer array; its layers point at it
  with `parentId` and always sit directly below it (`normalizeGroups`, run by `enforceLayerOrder`). Groups pass
  blend modes through: `compositeLayers` calls `resolveGroups`, which drops group entries and folds group
  visibility/opacity into their layers (unchanged when a frame has no groups). Lock checks use `isLockedIn`
  (own or a group's lock). A selected group stands for everything inside it (`selectedLayers`). Grouping
  linked layers, ungrouping, dropping and folding follow `linkId` across frames (`page.tsx`); Ctrl+G / Ctrl+Shift+G.
- Tools: Pencil (P), Brush (B, opens its panel), Eraser (E), Fill (G), Picker (I), Shapes (U).
- **Shapes** (`lib/raster/shapes.ts`, signed-distance fields): picked in the tool rail's Shapes flyout. A drag
  redraws the shape from a surface snapshot each move; release commits it to pixels like Fill (one undo step).
- Every paint edit is one undo step (`onHistoryCommit`) and sets `flattenKey: null`.
- Background is document state (`CanvasBackground`); checkerboard is view-only and never exported.
- Page layout is a fixed flex frame (Toolbar / sidebars / Canvas / Timeline). Nothing should shift size.
- **Per-frame cost while drawing is mostly the browser's**, not the brush engine's: never set React state on
  pointer moves (the brush cursor's element is moved in place), and never leave a still 2D canvas on the page
  (each frame copies every 2D canvas to the compositor; the onion skin is shown through a `bitmaprenderer`).
- **The stage is drawn by a worker** (`lib/stage`): `Canvas.tsx` hands its canvas over on mount
  (`StageClient`), then sends frames (`draw`) and stroke previews (`preview`, made on input, not at the next
  frame, so the worker shows them a frame sooner). Images and strokes cross once and go by key after.
  Pixels must match what the page drew: decoded images are drawn as the page's CPU raster would
  (`stage/geometry.ts`: mip levels made on the page). One draw in flight at a time; while it is, only the
  latest frame draw waits, and a preview is made when it can be sent.
  The stage canvas has no width/height attributes (the worker sizes it); read it with `StageClient.pick`.
