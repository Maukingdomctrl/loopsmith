# Loopsmith — Timeline & Animation Plan

Goal: the timeline should show and control **timing**, and the animation tools
(squash & stretch, bounce, hop) should grow into the classic principles —
**anticipation**, **ease**, **in-betweens** — without cluttering the screen.

Work through the steps **in order, one per session**. Each step ends with
`npm run build` passing, a quick check in the running app, a commit, and (as the
owner prefers) a pull request that is merged. Follow `CLAUDE.md`: small changes,
explain in plain words, keep prop names and file structure, less on screen,
never touch `src/lib/lsa/**` or `src/hooks/useAutoStabilize.ts`.

---

## What exists today (read before starting)

| Piece | Where | Notes |
|---|---|---|
| Timeline strip | `src/components/Timeline.tsx` (115 lines) | Props: `frames` (thumbnails = `frame.image`), `activeFrame`, select / reorder (drag) / add / duplicate / clear / delete. Footer is fixed `h-28` — **nothing may change its height**. |
| Frame model | `src/types/frame.ts` | `duration` = hold in ticks (1 tick = 1/fps s). `image` is the flatten cache (thumbnail, GIF, stabilizer hash). |
| Frame ops | `src/lib/frameOps.ts` | `createBlankFrame`, `duplicateFrame` (new layer ids, keeps `linkId`), `deleteFrame`, `reorderFrames`. |
| Frame indices | `src/app/page.tsx` | `activeFrame`, `editingIndex`, `previewFrame`. `selectFrame(i)` sets all three and stops playback. While playing, the canvas shows `previewFrame`; **the timeline still highlights `activeFrame`**. |
| Playback | `page.tsx` ~line 504 | Builds a sequence repeating each frame `duration` times; frames with no `image` are skipped. |
| Frame Hold UI | `src/components/RightSidebar.tsx` | Slider 1–12 ticks for the current frame only. |
| Onion skin | `page.tsx` `previousFrame=` (~line 1366) → `Canvas.tsx` | Previous frame only, drawn with `ONION_BACKGROUND`. |
| Squash & stretch, bounce, hop | `src/lib/layers/squash.ts`, `src/components/SquashPanel.tsx`, `applyBounce` in `page.tsx` | Actions `xf/squash`, `xf/hop` in `src/lib/layers/editor.ts`. Bounce runs over **all** frames with the current frame as the landing; `layer.hop` records the applied lift so re-bouncing replaces it. |
| GIF export | `src/lib/exportGif.ts` | Delay per frame = `(1000 / fps) × duration`. Keep smoothing / hard alpha cutoff / black nudge as they are. |

**Undo rules to reuse.** `updateProject(fn)` = one undo step. `updateProjectQuiet(fn)` = no
undo step (pair it with `handleHistoryCommit` at the start of a drag). Panel sliders that
dispatch to the layer editor call `editor.endGesture()` on pointer up/down so each drag is
exactly one step (see `SquashPanel.tsx`).

**Testing recipe (what worked in earlier sessions).** `npm run build`, then
`npx next start -p <port>` and a Playwright script using Chromium at
`/opt/pw-browsers/chromium`. Import frames through `input[type=file]`; add frames with
the dashed "+" button; read the canvas with `getImageData` on the 512×512 `<canvas>`;
use the Undo button (title `Undo (Ctrl+Z)`) rather than keys. Before committing, run
`git checkout -- tsconfig.tsbuildinfo` (the build rewrites it).

---

## Step 1 — See timing on the timeline

**Problem.** A frame's hold is only visible as a slider for the current frame, so the
rhythm of an animation can't be read at a glance. During playback the strip doesn't
follow what is playing.

**Do.**
1. Timeline gets `durations: number[]` and `playingFrame: number | null`.
2. Thumbnails with hold > 1 show a small badge in the corner (`×2`, `×3`…). No change in
   thumbnail size.
3. While playing, outline the playing frame (a thin ring, not the selected style) and
   scroll it into view.
4. Keyboard: `[` / `]` shorten / lengthen the current frame's hold (1–12), one undo step
   each. Ignore while typing in inputs (reuse the check in `page.tsx`'s key handler).

**Files.** `Timeline.tsx`, `page.tsx` (props + keys).
**Test.** 4 frames, holds 1/2/1/3 → badges ×2 and ×3; play → ring moves in rhythm; `]`
then Undo restores the hold. Footer height unchanged.

---

## Step 2 — Select several frames

**Problem.** Every timeline action works on one frame; animators work on ranges.

**Do.**
1. Page state `frameSelection: { anchor: number; ids: string[] }` (by frame **id**, not
   index — indices shift on reorder). Not saved with the project.
2. Click = select one (as today). Shift-click = range from anchor. Ctrl/Cmd-click = toggle.
   Selected-but-not-current frames get a lighter highlight.
3. Duplicate / Delete / `[` `]` hold apply to all selected frames, one undo step each.
   Delete must never remove the last frame.
4. Dragging a selected frame keeps working for a single frame; block drag can wait.

**Files.** `Timeline.tsx` (click modifiers, styles), `page.tsx` (state, actions).
**Test.** Select 2–3 by shift-click → Duplicate adds copies right after the block;
Delete removes them; Undo restores all at once.

---

## Step 3 — Bounce on a range

**Problem.** Bounce always covers the whole animation.

**Do.**
1. `applyBounce` works on the selected frames when 2+ are selected, otherwise all frames
   (today's behaviour).
2. The landing is the **first** selected frame; the cycle length is the number of
   selected frames. `bounceAmount` / `hopAmount` already take `(index, count, landing)` —
   pass the position inside the selection.
3. Button text follows: "Bounce selected frames" / "Bounce across all frames".

**Files.** `page.tsx` (`applyBounce`), `SquashPanel.tsx` (label only).
**Test.** 8 frames, select 3–6 → only those change; 1–2 and 7–8 untouched; one undo.

---

## Step 4 — Anticipation ("antic")

Anticipation is the small opposite move before the main action (the crouch before a jump).

**4a. Anticipation in the bounce.** A slider "Anticipation" (0–100 %, default 0) in the
bounce section:
- landing frame gets an extra squash on top of the bounce strength
  (e.g. `strength × (1 + antic)`),
- and an extra hold of `round(antic × 2)` ticks (so the crouch is held a beat),
- written into `frame.duration`; re-bouncing must reset the hold it added (store the
  added ticks like `layer.hop` does, e.g. `frame.anticHold`, or recompute from 1).

**4b. Insert antic frame** (timeline button or right-click on a frame, owner to choose):
1. Take the current frame `i` and the next frame `i+1`; direction = next base position −
   current base position (`pose.position`, canvas px). If they're equal, use "up" (a jump).
2. Duplicate frame `i` with `duplicateFrame`, insert it **before** `i`.
3. On the copy: squash (`xf/squash`, 30 % wider, anchor bottom) and move it a little
   **against** the direction (e.g. 8 px, or 25 % of the distance), hold 2 ticks.
4. One undo step; select the new frame.

**Files.** `squash.ts` (antic maths), `SquashPanel.tsx`, `Timeline.tsx`, `page.tsx`.
**Test.** Bird moving right: the antic frame sits slightly left and squashed; bounce with
anticipation 50 %: landing deeper and held longer; undo restores both.

---

## Step 5 — Onion skin before *and* after

**Problem.** Only the previous frame is shown, untinted.

**Do.**
1. `Canvas` gets `nextFrame` next to `previousFrame`.
2. Tint (view only, never exported): previous = red-ish, next = green-ish, drawn on an
   offscreen canvas then `source-atop` filled with the tint at ~35 %.
3. Right sidebar Onion Skin: keep the toggle; add two tiny toggles "Before / After"
   (default both on). Wrap at the ends of the loop (frame 1's "before" = last frame).

**Files.** `Canvas.tsx` (onion effect), `page.tsx`, `RightSidebar.tsx`.
**Test.** 3 frames → on frame 2 see 1 in red and 3 in green; export GIF has no tint.

---

## Step 6 — Play range and ping-pong

**Do.**
1. Timeline: "loop these frames" = the current multi-selection while playing (no new
   markers on screen).
2. A ping-pong toggle next to Play (1→N→1, without repeating the end frames).
3. Export: an option in `ExportDialog.tsx` to export ping-pong too (duplicates the frame
   list in reverse at export time only; the project doesn't change).

**Files.** `page.tsx` (playback sequence), `Toolbar.tsx`, `ExportDialog.tsx`, `exportGif.ts`
(only the frame list passed in — keep its pixel rules untouched).
**Test.** 4 frames ping-pong → play order 1 2 3 4 3 2 1 2 …; exported GIF has 6 frames
per cycle.

---

## Step 7 (optional) — In-betweens

**Do.** "Add in-between" between the current frame and the next: duplicate the current
frame, insert after it, set its base pose halfway between the two frames' poses
(position, rotation with shortest angle, scale), `hop` halfway too. Pixels stay those of
the current frame. Later: an ease choice (linear / ease-in / ease-out) picking 1/3 or 2/3
instead of 1/2.

**Files.** `frameOps.ts` (pose interpolation helper), `Timeline.tsx`, `page.tsx`.
**Test.** Frame A at y=300, B at y=200 → in-between at y=250; one undo.

---

## Out of scope for now

Per-layer keyframes, a full dope sheet, audio, frame-by-frame layer visibility tracks.
Revisit after Step 7 if the owner wants them.
