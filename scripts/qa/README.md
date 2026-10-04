# Brush-engine QA and performance pipeline

`scripts/qa` checks that a change keeps what the drawing pipeline guarantees:
exact brush output, the stage worker drawing exactly what the page would, and
the speed and latency of drawing. It drives the production build in headless
Chromium with pen events and compares the change (the **head**: your working
tree) with a **base** commit (default `origin/main`).

The Claude skill that runs it is `.claude/skills/brush-qa/SKILL.md`.

## Commands

| Command | What it does |
|---|---|
| `npm run qa` | Classifies the change and runs only the checks it needs. |
| `npm run qa -- --quick` | Same, with fewer repetitions. Use it while iterating. |
| `npm run qa:full` | Everything, on every rendering path. Use it before merging a renderer or brush change. |
| `npm run qa -- --base <ref>` | Compares against another base, e.g. `--base 5599dd0`. |
| `npm run qa:baselines` | A full run whose head results become the stored baselines. Run it on a clean `main`. |
| `npm run brush:check` | Brush precision checks only (no browser, ~10 s). |

Other options:

- `--tier fast|pixels|perf|full` forces a tier.
- `--paths cpu,gpu,fallback,no-offscreen` picks the rendering paths.
- `--ab` captures the base even when the stored hashes cover it.
- `--jobs <n>` sets how many pixel runs go side by side (default 2 on 4+ cores).
- `--out <dir>` sets the output folder.

How long a run takes on a 4-core machine:

| Run | Time |
|---|---|
| pixels tier | 3.5 min with the stored baselines (5 min when the base must be captured too) |
| a brush-engine change | about 25 min (estimated from the runs below) |
| `qa:full` | 29 min with the stored baselines, 38 min without |

Under SwiftShader the GPU path is the slow part: about 45 s per brush stroke
run.

Each run writes `.qa/<date-time>/report.md` (read this first) and `results.json`
(every number), plus `logs/`, `pixels/` (every capture) and `runs/` (traces,
profiles, per-run JSON). The newest five runs are kept. The exit code is 1 on
any **FAIL** or **REGRESSION**.

## What runs when

`classify.mjs` reads every file changed since the merge base with the base:
committed, staged, unstaged and untracked. It picks the highest tier any file
needs. `node scripts/qa/classify.mjs` prints the decision without running
anything.

| Tier | Files | What runs |
|---|---|---|
| none | docs (`*.md`, `docs/`, `.claude/`), `scripts/qa/baselines/` | nothing |
| fast | tooling: `scripts/brush-check/`, configs, `public/`, package changes that are dev-only | harness syntax, `brush:check`, lint delta, production build |
| pixels | app code and UI (`src/**` not below), the QA harness itself | fast + pixel regression on the CPU path, image-path contract |
| perf, light plan | pointer-path code that draws nothing: `src/app/page.tsx`, `BrushCursor.tsx`, `useLayerEditor.ts`, `history.ts`, `frameOps.ts`, other `src/lib/layers/*` | pixels + timing of `hardLine` and `pencil` at 240 Hz, latency of `hardLine` |
| perf, full plan | brush engine (`src/lib/raster/`, `src/lib/pencil/`) | pixels on cpu, gpu, fallback + full timing, latency and stage breakdown |
| perf, full plan | compositor (`layers/composite`, `adjust`, `groups`, `flatten`, `layerSpace`, `drawFrame`, `frameTransform`, `geometry/`) | the same on every path |
| perf, full plan | stage worker / canvas (`src/lib/stage/`, `Canvas.tsx`), app dependencies and build config | the same on every path, plus the `next dev` smoke test |

A `package.json` / `package-lock.json` change counts as tooling ("fast") when
it touches no app dependency, no build tool (Tailwind, PostCSS), and no
`build`/`start` script.

Files CLAUDE.md protects (`src/lib/lsa/**`, `useAutoStabilize.ts`, the sprite
cutter, `exportGif.ts`) get a **WARN** whenever they change.

## Rendering paths

| Path | How | Stage drawn by |
|---|---|---|
| `cpu` | default headless Chromium (CPU raster, software compositing) | the stage worker |
| `gpu` | SwiftShader GPU raster (`--use-angle=swiftshader --enable-gpu-rasterization`) | the stage worker |
| `fallback` | `transferControlToOffscreen` removed (browsers without it) | the page |
| `no-offscreen` | `OffscreenCanvas` removed too (Safari before 16.4) | the page; onion skin on a 2D canvas |

Every head run also checks who draws the stage. If the worker fails to start
on `cpu`, the run fails; it doesn't quietly fall back to the page.

## The guarantees it checks

1. **Byte-identical output.** The brush oracle draws every tool (`hardLine`,
   `softRound`, `softRect`, `water`, `texture`, `pencil`) twice, at one event
   per frame (`await`) and at 240 Hz (`hz`). It captures the stage before
   pen-up and after the commit, plus every PNG the app encodes. The scenario
   suite (`scenarios.mjs`) drives the editor:
   - pencil, eraser, undo/redo, zoom;
   - Soft Round, Water, shapes, fill, eyedropper;
   - layers: blend, opacity, clipping, masks painted by brush and pencil,
     adjustment layer;
   - frames: onion skin, window resize;
   - imports of big, power-of-two and medium images at several zooms.

   That is 80 oracle captures and 70 scenario captures, 150 per path. Each one
   must be byte-identical to the base's capture, or to the stored hash when the
   stored baseline covers the base (same browser and CPU class, same app code).
   A head capture that differs from the stored hash makes the pipeline capture
   the base too, so a failure always rests on a direct comparison.

   The one tolerance is on the `gpu` path. SwiftShader's GPU raster isn't
   bit-exact from run to run: a live preview can land one level apart on a
   few pixels. A difference of at most 1 level on at most 0.05 % of a
   capture's pixels is reported as GPU raster jitter (WARN); anything larger
   fails. CPU raster, where the app promises exact pixels, has no tolerance.
2. **Worker/page parity.** On CPU raster, the stage the page draws
   (`fallback`, `no-offscreen`) must be byte-identical to the stage the worker
   draws (`cpu`). CLAUDE.md: "Pixels must match what the page drew".
3. **Image-path contract** (`image-path.mjs`). There are 96 cases of decoded
   images at odd sizes, sub-rects, densities 0.2–1.3 and rotations. On CPU
   raster, drawing a page `<img>` must equal the worker's `ImageBitmap` draw
   with emulated mip levels (`stage/geometry.ts`). Re-check it after a
   Chromium update.
4. **Brush precision** (`npm run brush:check`). There are 35 precision
   measures (coverage against the exact area, light touch, sub-pixel
   position, pressure curves, 60 vs 500 Hz, path, hard edge, ends and taps,
   every brush) and 5 cost measures. A FAIL line fails the run. A precision
   value worse than the base, even within its limit, is a WARN.
5. **Development mode** (`dev-smoke.mjs`). React Strict Mode mounts the stage
   twice, and a canvas can go to a worker only once. Under `next dev`, exactly
   one stage worker must load, a stroke must draw, and nothing may be logged.

## Performance: what is measured

Base and head are measured on the same machine, interleaved run by run. The
order flips between configurations, so drift in the machine favours neither
side.

| Measure | How | Source |
|---|---|---|
| Main-thread time per stroke | Renderer `TaskDuration` (CDP `Performance.getMetrics`, no tracing) over a 241-event stroke, from pen-down until the commit settles. Median of warm strokes: 5 per side, 3 with `--quick`. Split into during the stroke and after pen-up (the commit). | `stroke.mjs` |
| Wall time (`await`) | How long the 241 frame-paced events take end to end: 241 frames (≈ 4.0 s at 60 Hz) unless frames are missed. | `stroke.mjs` |
| Pen-to-screen latency | For each `pointermove`: the frame that carries its drawing to the display compositor (the worker's `DispatchFrame`, or the page's commit and submit), then viz's next `DrawAndSwap`. Median and p90 per traced run, median over 3 runs. The mean is split into "to the display compositor" + "to screen". | `lib/trace.mjs` `penToScreen` |
| Cost per thread | Busy time while drawing (union of top-level tasks) of the page main thread, stage worker, renderer compositor, raster workers and display compositor. | `threadBusy` |
| Per-stage breakdown | Page-thread time per stage: input routing, React dispatch, stroke model, rasterization, dirty-region conversion, stage hand-off, upload, compositing, React re-render, page lifecycle, commit, GC. JS stages come from a V8 CPU profile, browser stages from the trace. The largest stage is the **dominant bottleneck**. | `stageBreakdown` |
| Brush cost | µs per pointer sample (curve + model + incremental preview), brush:check §11. | `brush-check` |

Builds are `next build --no-mangling`: the same compile and type check as
`npm run build`, with function names kept so the profiles read in source
names. The base is built in a git worktree under `$QA_CACHE` (default
`<tmp>/loopsmith-qa/builds/<commit>`), once per commit. Two builds of the same
source serve byte-identical JavaScript (checked: every client chunk), so an
A/B difference comes from the code, not the build.

## Thresholds

A change counts only past both limits, so noise on small numbers doesn't
trip it. A flagged timing is re-measured with two more runs per side before
it is called a **REGRESSION**. The thresholds live in `THRESHOLDS` in
`qa.mjs`.

| Measure | Regression when the head is worse by |
|---|---|
| Pixels, parity, image-path contract | any byte (FAIL) |
| Pixels on the `gpu` path | more than 1 level, or on more than 0.05 % of a capture's pixels (FAIL); less is jitter (WARN) |
| Main-thread time per stroke (median) | > 12 % and ≥ 20 ms (REGRESSION) |
| Pen-to-screen median | > 15 % and ≥ 3 ms (REGRESSION) |
| Pen-to-screen p90 | > 25 % and ≥ 5 ms (REGRESSION) |
| Stage-worker busy time | > 25 % and ≥ 20 ms (WARN) |
| brush:check cost per sample (fastest of 1–3 runs per side) | > 40 % and ≥ 50 µs (WARN; this micro-benchmark varies ±25 % between processes, and the main-thread timing above covers the same work end to end) |
| vs the stored perf baseline (same machine type) | > 20 % (WARN) |

GPU timings are not measured: SwiftShader's timings say nothing about a real
GPU. Its pixels are checked.

## Baselines

`scripts/qa/baselines/` holds what `main` produced at the commit it names,
on the machine it describes (`env`):

- `pixels.json`: a SHA-256 prefix of every capture, per rendering path. It
  applies when the browser version, platform, architecture and CPU vector
  class match, and the base has the same app code as the recorded commit.
  When it applies, the base needn't be built for its pixels.
- `perf.json`: the head's medians per configuration (main-thread, during,
  after pen-up, stroke time), latency (median, p90, legs, per-thread cost)
  and the stage breakdown. It is compared only on the same machine type.
  Timings vary between sessions, so this comparison only warns; the A/B
  against the base decides.
- `brush-check.json`: every brush:check value. The precision values are
  deterministic, so they apply anywhere.

Re-record them (`npm run qa:baselines` on a clean `main`) after a change that
is meant to alter pixels or timings has merged, and after a Chromium update.
The run refuses to record if anything failed or the tree has uncommitted app
changes. Commit the three files.

The baselines recorded with this pipeline are in
[Recorded results](#recorded-results), with the history from PR #30 and
PR #31.

## Individual tools

All take `--url` (default `http://localhost:3000/`; use a production build:
`npm run build && npx next start`).

| Script | Use |
|---|---|
| `stroke.mjs` | One tool, N strokes: `--brush hardLine\|softRound\|softRect\|water\|texture\|pencil --pace await\|hz --strokes 6 --path cpu --out run.json`. Add `--pixels dir` (captures), `--trace t.json`, `--cpuprofile c.json`, `--wrap` (per-call canvas timings). |
| `scenarios.mjs` | The scenario suite: `--out dir [--path p] [--only pencil,layers]`. |
| `latency.mjs trace.json…` | Pen-to-screen latency from traces. |
| `threads.mjs trace.json` | Busy time per thread, and the page thread's top activities. |
| `stages.mjs cpu.json run.json trace.json` | Per-stage breakdown and the dominant stage. The three files come from one `stroke.mjs --cpuprofile --trace --out` run. |
| `cpu-top.mjs cpu.json [--incl a,b] [--from ms --to ms]` | Self and inclusive time per function. |
| `trace-callers.mjs trace.json [Event]` | What triggers an event on the page thread (default: 2D canvas hand-offs to the compositor). |
| `pngdiff.mjs a.png b.png [--viz out.png --box x,y,w,h]` | How two captures differ, and a side-by-side crop. |
| `image-path.mjs [--path gpu]` | The image-path contract. |
| `dev-smoke.mjs --url <next dev url>` | The development-mode check. |
| `classify.mjs`, `lint-delta.mjs` | The tier decision; lint problems the change adds. Both take `--base`. |

## Troubleshooting

- **Pixels differ.** Open the report's list of differing captures and look at
  one:
  `node scripts/qa/pngdiff.mjs .qa/<run>/pixels/base/cpu/<file> .qa/<run>/pixels/head/cpu/<file> --viz diff.png`.
  - Small, spread differences (max 1–2) usually mean a changed draw order,
    smoothing, or float path.
  - Differences only before pen-up point at the preview.
  - Differences only after the commit point at the commit or encode.
  - Differences only on imports at low zoom point at decoded-image
    resampling (`stage/geometry.ts`; run `image-path.mjs`).

  Before blaming the change, rerun with `--base HEAD`. A no-change run must
  be fully identical; if it isn't, the harness or the machine is not
  deterministic. Look for a new use of time or randomness that the page
  set-up in `lib/env.mjs` doesn't pin.
- **GPU raster jitter (WARN).** This is a capture on the `gpu` path a level
  apart on a handful of pixels, usually a live preview. Ignore it unless the
  same capture keeps moving between runs, or the difference grows past the
  tolerance.
- **Parity fails, but the A/B passes.** The worker and the page draw
  differently. Check what changed in `stage/renderer.ts`, `geometry.ts`, and
  the `draw` hook in `composite.ts`.
- **A timing regression.** Rerun: a confirmed regression survived two rounds
  already. Then open the stage table and the kept traces:
  - `node scripts/qa/threads.mjs <trace>` (which thread, which activity);
  - `node scripts/qa/cpu-top.mjs <cpu.json>` (which function);
  - `node scripts/qa/trace-callers.mjs <trace>` (what triggers canvas
    hand-offs).

  To find the commit or line responsible, measure an ablation: revert one
  piece, rebuild, then run `stroke.mjs` on both builds interleaved, with 6
  strokes each. Compare medians, never single strokes.
- **Latency is worse but main-thread time isn't.** Check the legs. A longer
  "to the display compositor" leg points at the worker or the page frame,
  e.g. a draw posted from `requestAnimationFrame` instead of on input. A
  longer "to screen" leg points at the display compositor.
- **A run fails or times out.** Read the log the verdict names under
  `.qa/<run>/logs/`. `server-*.log` and `build-*.log` hold the server and
  build output.
- **No browser.** Set `CHROME_PATH`, or `PLAYWRIGHT_BROWSERS_PATH` to a
  folder with a `chromium-*` build. Keep `playwright-core`'s version matched
  to that Chromium (1.56 ↔ Chromium 141). Cloud sessions have one in
  `/opt/pw-browsers`.
- **The base won't build.** See `logs/build-base.log`. Delete
  `$QA_CACHE/builds/<commit>` to start over. The base's `node_modules` is
  hard-linked from the repo when the lockfiles match, otherwise it comes from
  `npm ci`, which needs the npm registry.
- **The stored baseline doesn't apply.** This happens on another machine,
  another Chromium, or after an app change on main. The report says so, and
  the base is built and captured instead. Nothing is lost but time.
- **Disk.** Each run keeps one trace per side (~16 MB each) plus its
  captures. `.qa/` keeps five runs. The base builds stay in `$QA_CACHE`
  (~600 MB each). They are git worktrees, so `git worktree list` shows them.
  Remove one with `git worktree remove --force <dir>`, or delete the folder
  and run `git worktree prune`.

## Recorded results

These runs used Chromium 141.0.7390.37 on linux x64, on an Intel Xeon @ 2.10 GHz
× 4 (avx512), in a cloud session in October 2026.

### No change: `npm run qa:baselines` on `main` (0a25003)

The head and the base are the same app, so every difference here is noise.
The run took 38 min and passed.

- **Pixels.** CPU and GPU: 150/150 identical to the base. Fallback and
  no-offscreen: 150/150 identical to the worker's stage. Image-path
  contract: 96/96. Dev smoke: ok. brush:check: 40/40, every precision value
  equal.
- **Noise floor.** Across the 14 timing configurations, main-thread time
  moved −4 % … +9 %, pen-to-screen medians ±11 %, and per-thread busy time
  ±10 %. The thresholds sit above this, and anything flagged is re-measured
  before it counts.
- **The head's numbers became the stored baselines**
  (`scripts/qa/baselines/`). Median main-thread ms per stroke, `await` /
  `hz`:

  | Tool | `await` / `hz` |
  |---|---|
  | hardLine | 320 / 183 |
  | softRound | 309 / 184 |
  | softRect | 331 / 208 |
  | water | 463 / 318 |
  | texture | 337 / 205 |
  | pencil | 334 / 195 |
  | fallback hardLine / pencil (`hz`) | 202 / 377 |

  Pen-to-screen latency, median (p90): hardLine 13.7 ms (21.8), pencil
  16.9 ms (24.9), fallback hardLine 22.7 ms (28.7).
- An earlier attempt at this run failed one GPU capture: a live brush preview
  over a large import, 1 level apart on 6 pixels. That is SwiftShader
  jitter, which led to the GPU tolerance described above. CPU raster never
  moved.
- Two later runs used the stored baselines:
  - `npm run qa` on this branch was classified pixels-on-CPU. It finished in
    3.5 min without building the base: 150/150 captures and every precision
    value matched the stored baseline.
  - `npm run qa:full` on the final code passed with nothing flagged in
    29 min. Every path matched the stored hashes (600/600), with parity,
    the contract and dev smoke. Timings showed no regression, and stayed
    within 20 % of the stored perf baseline.

### PR #31 reproduced: `npm run qa -- --base 5599dd0 --tier full`

The head is the stage worker (`main`, 0a25003); the base is the commit
before it (5599dd0). The run took 38 min.

- **Pixels.**
  - CPU: 150/150 captures byte-identical. The worker draws exactly what the
    page drew.
  - GPU: 136/150 identical. The 14 that differ are the `import-big` and
    `import-pow2` scenario captures, where the worker approximates decoded
    images drawn below half size on GPU raster. That is the known limitation
    PR #31 accepted: then 56/70 scenario captures, now the same 14 out of 150
    with the oracle added.
  - Fallback and no-offscreen: 150/150 identical to the worker's stage.
  - Image-path contract: 96/96. Dev smoke: ok.
- **Main-thread time** per 241-event stroke, base → head (median ms):

  | Tool | `await` | `hz` |
  |---|---|---|
  | hardLine | 413 → 304 (−26 %) | 203 → 180 (−11 %) |
  | softRound | 437 → 316 (−28 %) | 211 → 181 (−14 %) |
  | softRect | 489 → 358 (−27 %) | 222 → 198 (−11 %) |
  | water | 558 → 466 (−17 %) | 318 → 302 (−5 %) |
  | texture | 469 → 334 (−29 %) | 238 → 199 (−16 %) |
  | pencil | 935 → 326 (−65 %) | 381 → 188 (−51 %) |

- **Pen-to-screen latency**, median (p90):
  - hardLine: 24.5 → 12.7 ms (31.0 → 18.8). PR #31 measured 24.7 → 12.8.
  - pencil: 28.5 → 17.7 ms (34.8 → 25.9).

  The leg to the display compositor halved (hardLine 21.8 → 9.2 ms mean);
  the leg to screen stayed at ~3 ms.
- **Threads**, hardLine, busy ms while drawing:
  - page main thread: 255 → 243;
  - stage worker: 0 → 139;
  - display compositor: 161 → 169.
- **Stages.** For a pencil stroke, canvas upload went 125 → 0 ms and
  compositing on the page 65 → 0 ms; the traced page thread went
  530 → 363 ms. The dominant stage is now the page lifecycle (style, layout,
  paint: 78 ms).
- Two verdicts in this run's report were the pipeline's own faults and are
  fixed:
  - the lint delta counted renamed identifiers as new errors (it now counts
    per rule: 0 new against 5599dd0);
  - the stage worker's cost was a WARN when the base had no worker (now
    INFO).

### A regression, caught

The pre-worker app (5599dd0) was put up as the head against `main`, in a
separate worktree, with `--tier perf --quick --paths cpu`. The run took 22
min and exited 1:

- **FAIL**: every head run drew the stage on the page instead of the worker.
- **8 REGRESSIONs**, each confirmed by a second round:
  - main-thread time: hardLine `await` 309 → 426 ms (+38 %); softRound
    `await` +38 % and `hz` +18 %; water `await` +25 %; pencil `await`
    334 → 902 ms (+170 %) and `hz` +76 %;
  - latency: hardLine 12.1 → 25.4 ms; pencil 17.8 → 27.1 ms.
- hardLine `hz` (+11 %) and water `hz` (+3 %) stayed under the threshold.
- Pixels: 116/116 identical. The worker never changed what is drawn.
- The bottleneck for pencil: "Canvas upload" (116 ms), the cost PR #31
  removed.

### History, from the PRs' own sessions

These came from earlier versions of these scripts, each in its own session.
Compare numbers within a table, not across tables.

[PR #30](https://github.com/Maukingdomctrl/loopsmith/pull/30) cut the
browser's per-frame work while drawing. Median main-thread ms per 241-event
stroke, before → after:

| Brush | `await` (1 event per frame) | `hz` (240 Hz) |
|---|---|---|
| Hard Linework | 997 → 612 | 403 → 260 |
| Soft Round | 1008 → 588 | 399 → 255 |
| Soft Rectangle | 1050 → 612 | 442 → 283 |
| Water | 1204 → 718 | 536 → 379 |
| Texture | 1112 → 619 | 443 → 303 |

The traced main thread went from 1208 to 646 ms, with latency unchanged.

[PR #31](https://github.com/Maukingdomctrl/loopsmith/pull/31) moved the stage
to a worker. Median main-thread ms, before → after:

| Tool | `await` | `hz` |
|---|---|---|
| Hard Linework | 559 → 370 | 241 → 205 |
| Soft Round | 561 → 370 | 246 → 207 |
| Water | 655 → 498 | 342 → 329 |
| Pencil | 1082 → 360 | 429 → 217 |

Pen-to-screen latency, median (p90): Hard Linework 24.7 → 12.8 ms
(30.9 → 20.8); Pencil 27.7 → 18.3 ms (32.4 → 24.5). Pixels stayed
byte-identical on CPU raster, the fallback path matched, and GPU raster
differed only on imported images shown below half size, where the worker
approximates.
