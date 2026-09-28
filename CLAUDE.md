# Loopsmith — notes for Claude

Next.js + TypeScript app that turns AI-generated spritesheets into clean animated emojis/GIFs.
Flow: **Import & cut → Studio (stabilize, background, touch-up) → Export**.

## Commands
- `npm run dev` — local app at http://localhost:3000
- `npm run build` — must pass (type check included) before any change is done

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
- **All paint tools edit the base layer's own pixels**, never a screen-space mask. They use the
  `lib/raster` engine (`RasterSurface`, `BrushStroke`, `EraserStroke`, `floodFill`) and commit via
  `surface.commit()` → layer `image` + `flattenKey: null`. One stroke = one undo step (`onHistoryCommit`).
- Background is document state (`CanvasBackground`); checkerboard is view-only and never exported.
- Page layout is a fixed flex frame (Toolbar / sidebars / Canvas / Timeline). Nothing should shift size.

## Known leftovers (safe to delete when tidying)
`LeftSidebar.tsx`, `EmojiLibrary.tsx`, `lib/templateRegistry.ts`, `lib/createTemplateProject.ts`,
`lib/geometryPresets.ts`, `src/templates/**`, `components/editor/panels/TransparencyPanel.tsx`,
the old `frame.transparency` mask path, `tree.txt`, `tsconfig.tsbuildinfo`.
