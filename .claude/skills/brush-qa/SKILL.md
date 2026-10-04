---
name: brush-qa
description: Runs Loopsmith's brush-engine QA and performance pipeline (scripts/qa) and reads its report. It covers pixel-exact regression tests of every brush and editor scenario on the CPU, GPU/worker and fallback rendering paths, worker/page parity, brush precision checks, and base-vs-head timing, pen-to-screen latency, per-thread cost and per-stage bottleneck profiles. Use it before calling any change under src/ done, whenever a change touches the brush engine, compositor, stage worker or canvas, when asked to measure speed or latency or to find a bottleneck, and when baselines need recording.
---

# Brush QA and performance pipeline

The harness is already built: `scripts/qa/`. Its full reference, with every
command, threshold, baseline and troubleshooting step, is
`scripts/qa/README.md`. **Use the harness; do not write a new one.** If a check
is missing, extend the existing scripts. To add a scenario, add a step to
`scenarios.mjs`; to add a tool, add it to `TOOLS` in `qa.mjs`.

## 1. Run it

From the repository root, with `node_modules` installed:

```bash
npm run qa                 # classifies the change and runs what it needs
npm run qa -- --quick      # the same with fewer repetitions, while iterating
npm run qa:full            # every check on every rendering path; before merging renderer work
```

- It compares the working tree (head) with `origin/main` (base). If
  `origin/main` is stale, run `git fetch origin main` first. Use
  `--base <ref>` for another base.
- It runs, in order:
  - **fast**: `brush:check`, the lint delta and the production build;
  - **pixels**: byte-exact captures, parity and the image-path contract;
  - **perf**: interleaved base/head timing, latency, per-thread cost and the
    stage breakdown.
- Expensive steps run only when the change needs them:

  | Change | Tier |
  |---|---|
  | Docs only | nothing runs |
  | Tooling | fast |
  | UI or app code | pixels on CPU |
  | Pointer-path code | light perf |
  | Brush engine, compositor, stage worker, canvas, app dependencies | full perf on every affected path |

  `node scripts/qa/classify.mjs` shows the decision without running anything.
- The run takes 3.5 min (pixels tier) to 30–40 min (`qa:full`) on 4 cores.
  Run it in the background, then read the summary.
- Exit code 1 means a **FAIL** or a confirmed **REGRESSION**.

## 2. Read the report

The last lines print `report: .qa/<run>/report.md`. Read the **Verdicts**
section first:

- **FAIL**: something broke. It can be a build or lint error, a brush:check
  limit, a page error, a capture that differs from the base or the stored
  hash, worker/page parity, the image-path contract, or the stage drawn on
  the wrong path. Fix it before going on.
- **REGRESSION**: a timing got worse past its threshold and the second round
  confirmed it. Treat it as a bug in the change unless the user accepted the
  cost.
- **WARN**: look, then decide. Examples: a protected file changed (CLAUDE.md),
  a precision value got worse within its limit, slower brush cost, GPU raster
  jitter (≤ 1 level on a few pixels, SwiftShader only), a stored baseline that
  is out of date. Say in your reply what you decided.
- **PASS / INFO**: the evidence. INFO also names the **dominant bottleneck**:
  the largest page-thread stage and the busiest thread.

## 3. Rules

1. **Pixels are exact.** Any differing capture is a failure unless the user
   asked for a visual change. If they did, show the differences:
   `node scripts/qa/pngdiff.mjs <base.png> <head.png> --viz diff.png`. List
   the changed captures in the PR, and tell the user the baselines need
   re-recording after the merge.
2. **Keep the guarantees.**
   - The stage the worker draws must equal the page's on CPU raster (parity).
   - The image-path contract must pass 96/96.
   - brush:check must have no FAIL.
   - Never loosen a threshold, skip a check, or edit a baseline to make a run
     pass.
3. **Never update baselines on a branch.** Only run `npm run qa:baselines`
   on a clean `main`, after a merge that meant to change pixels or timings,
   or after a Chromium update, and only when the user agrees. Commit the
   three files in `scripts/qa/baselines/`.
4. **Report numbers, before → after.** For perf-relevant work, paste the
   report's performance tables (main-thread time, pen-to-screen latency,
   per-thread cost, stage breakdown with its dominant stage) into the PR
   description. Only compare numbers measured in the same run: different
   sessions and machines differ by 10–30 %.
5. **A timing difference is noise until a re-run agrees.** The pipeline
   already confirms flagged timings once. For a decision, rerun
   `npm run qa -- --tier perf`.

## 4. Dig into a bottleneck or a regression

Every run keeps one trace per side, plus a CPU profile for the stage
breakdown, under `.qa/<run>/runs/`. Use them:

```bash
node scripts/qa/threads.mjs   <trace.json>             # which thread, which activity
node scripts/qa/latency.mjs   <trace.json>             # pen → screen, and its two legs
node scripts/qa/stages.mjs    <cpu.json> <run.json> <trace.json>   # per-stage, dominant stage
node scripts/qa/cpu-top.mjs   <cpu.json> --top 30      # hottest functions
node scripts/qa/trace-callers.mjs <trace.json>         # what makes the page hand 2D canvases to the compositor
```

To measure one configuration by hand, serve a production build
(`npx next build --no-mangling && npx next start -p 3000`), then run:

```bash
node scripts/qa/stroke.mjs --brush hardLine --pace hz --strokes 6                    # main-thread time
node scripts/qa/stroke.mjs --brush pencil --pace hz --trace t.json --cpuprofile c.json --out r.json
node scripts/qa/scenarios.mjs --out /tmp/sc --only layers                              # one scenario session
```

To find which part of a change costs time, do an ablation:

1. Revert one piece and rebuild.
2. Run `stroke.mjs` on both builds, interleaved, with 6 strokes each.
3. Compare medians, never single strokes.

## 5. When it cannot run

`scripts/qa/README.md` → Troubleshooting covers each of these:

- no browser found (`CHROME_PATH`, `PLAYWRIGHT_BROWSERS_PATH`);
- the base won't build (`$QA_CACHE`, `logs/build-base.log`);
- the stored baseline doesn't apply (another machine or Chromium version: the
  base is built and captured instead);
- a no-change run that isn't identical: run with `--base HEAD`, which must
  pass fully.
