// Which checks a change needs. Reads the files changed since the base
// (committed, staged, unstaged and untracked) and sorts them by what they
// can break:
//
//   none    documentation, recorded baselines: nothing to run
//   fast    tooling: build, brush precision checks, lint
//   pixels  app code and UI: fast + pixel regression on the CPU path
//   perf    code on the drawing path: pixels + timing and latency profiles
//
// Code the stage, the compositor or a brush runs through every frame
// (`plan: "full"`) is profiled in full on the rendering paths it can affect;
// code that runs on each pointer event but draws nothing (`plan: "light"`)
// gets a short timing check that would catch, say, React state set on
// pointer moves.
//
//   node scripts/qa/classify.mjs [--base origin/main]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { options } from "./lib/env.mjs";
import { git, repoRoot } from "./lib/serve.mjs";

export const TIERS = ["none", "fast", "pixels", "perf"];
const ALL_PATHS = ["cpu", "gpu", "fallback", "no-offscreen"];

/** First match wins. `dev`: also run the `next dev` smoke test. */
export const RULES = [
  { test: /\.(md|mdx|txt)$|^docs\/|^\.claude\/|^LICENSE/i, tier: "none", why: "documentation" },
  { test: /^scripts\/qa\/baselines\//, tier: "none", why: "recorded baselines" },
  { test: /^scripts\/qa\//, tier: "pixels", why: "the QA harness (checked against the stored baselines)" },
  { test: /^scripts\/brush-check\//, tier: "fast", why: "brush precision checks" },
  { test: /^src\/lib\/stage\/|^src\/components\/Canvas\.tsx$/, tier: "perf", plan: "full", paths: ALL_PATHS, dev: true, why: "stage worker / canvas" },
  { test: /^src\/lib\/(layers\/(composite|adjust|groups|flatten|layerSpace)|drawFrame|frameTransform)\.ts$|^src\/lib\/geometry\//, tier: "perf", plan: "full", paths: ALL_PATHS, why: "compositor" },
  { test: /^src\/lib\/(raster|pencil)\//, tier: "perf", plan: "full", paths: ["cpu", "gpu", "fallback"], why: "brush engine" },
  { test: /^(package(-lock)?\.json|next\.config\.\w+|tsconfig\.json|postcss\.config\.\w+)$/, tier: "perf", plan: "full", paths: ALL_PATHS, dev: true, why: "dependencies / build config" },
  { test: /^src\/app\/page\.tsx$|^src\/components\/BrushCursor\.tsx$|^src\/hooks\/useLayerEditor\.ts$|^src\/lib\/(history|frameOps)\.ts$|^src\/lib\/layers\//, tier: "perf", plan: "light", paths: ["cpu"], why: "pointer path / document state" },
  { test: /^src\//, tier: "pixels", paths: ["cpu"], why: "app code / UI" },
  { test: /^public\//, tier: "fast", why: "static assets" },
  { test: /.*/, tier: "fast", why: "other" },
];

/** Files CLAUDE.md asks to keep as they are. */
export const PROTECTED = [
  { test: /^src\/lib\/lsa\/|^src\/hooks\/useAutoStabilize\.ts$/, note: "Auto stabilize: CLAUDE.md says do not modify" },
  { test: /^src\/lib\/sprite\/(slice|occupancy|ownership)\.ts$|^src\/components\/SpriteSheetCutter\.tsx$/, note: "clean-edge cutting (extractCleanCells): keep it" },
  { test: /^src\/lib\/exportGif\.ts$/, note: "GIF export: keep smoothing, the hard alpha cutoff and the black nudge" },
];

/** Dev-only packages that still shape the build's output (the CSS). */
const BUILD_TOOLS = /tailwind|postcss|lightningcss/;

/**
 * package.json and package-lock.json changes that cannot reach the app — dev
 * tooling, npm scripts other than build/start — are "fast"; anything else
 * (an app dependency, the build) stays on the full plan.
 */
function packageRule(file, mergeBase, root, head) {
  let before, after;
  try {
    before = JSON.parse(git(["show", `${mergeBase}:${file}`], root));
    after = JSON.parse(head ? git(["show", `${head}:${file}`], root) : fs.readFileSync(path.join(root, file), "utf8"));
  } catch { return null; }
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const tooling = { tier: "fast", why: "dev tooling only (no app dependency or build change)" };
  const devBuild = (p) => Object.fromEntries(Object.entries(p?.devDependencies ?? {}).filter(([k]) => BUILD_TOOLS.test(k)));
  const appFacing = (p) => [p?.dependencies, devBuild(p), p?.scripts?.build, p?.scripts?.start, p?.browserslist, p?.type];
  if (file === "package.json") return same(appFacing(before), appFacing(after)) ? tooling : null;
  // the lockfile: the root entry as package.json, then every package that
  // changed must be dev-only (npm marks those `dev: true`) and not a build tool
  const keys = new Set([...Object.keys(before.packages ?? {}), ...Object.keys(after.packages ?? {})]);
  for (const k of keys) {
    const a = before.packages?.[k], b = after.packages?.[k];
    if (same(a, b)) continue;
    if (k === "" ? !same(appFacing(a), appFacing(b)) : !(b ?? a).dev || BUILD_TOOLS.test(k)) return null;
  }
  return tooling;
}

/** Every file changed since `base`'s merge base, including uncommitted and untracked ones. */
export function changedFiles(base, root = repoRoot()) {
  const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);
  const mergeBase = git(["merge-base", base, "HEAD"], root);
  const files = new Set([
    ...lines(git(["diff", "--name-only", mergeBase], root)),
    ...lines(git(["ls-files", "--others", "--exclude-standard"], root)),
  ]);
  return { mergeBase, files: [...files].sort() };
}

/**
 * The tier, rendering paths and plan a list of changed files calls for.
 * With `mergeBase`, package.json / package-lock.json changes are read to tell
 * dev tooling from app dependencies (against the working tree, or `head`).
 */
export function classify(files, { mergeBase = null, root = null, head = null } = {}) {
  const rank = (t) => TIERS.indexOf(t);
  const out = { tier: "none", plan: null, paths: new Set(), dev: false, files: [], protected: [] };
  for (const file of files) {
    const pkg = mergeBase && /^package(-lock)?\.json$/.test(file) ? packageRule(file, mergeBase, root ?? repoRoot(), head) : null;
    const rule = pkg ?? RULES.find((r) => r.test.test(file));
    out.files.push({ file, tier: rule.tier, why: rule.why, plan: rule.plan ?? null });
    if (rank(rule.tier) > rank(out.tier)) out.tier = rule.tier;
    if (rule.plan === "full" || (rule.plan === "light" && !out.plan)) out.plan = rule.plan;
    for (const p of rule.paths ?? []) out.paths.add(p);
    out.dev ||= !!rule.dev;
    const prot = PROTECTED.find((p) => p.test.test(file));
    if (prot) out.protected.push({ file, note: prot.note });
  }
  if (rank(out.tier) >= rank("pixels")) out.paths.add("cpu");
  out.paths = ALL_PATHS.filter((p) => out.paths.has(p));
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opt = options();
  const base = String(opt("base", "origin/main"));
  const { mergeBase, files } = changedFiles(base);
  const c = classify(files, { mergeBase });
  console.log(`changes since ${base} (merge base ${mergeBase.slice(0, 9)}): ${files.length} files`);
  for (const f of c.files) console.log(`  ${f.tier.padEnd(6)} ${f.plan ? `(${f.plan}) ` : ""}${f.file}  — ${f.why}`);
  for (const p of c.protected) console.log(`  PROTECTED ${p.file}: ${p.note}`);
  console.log(`tier: ${c.tier}${c.plan ? ` (perf plan: ${c.plan})` : ""}; rendering paths: ${c.paths.join(", ") || "none"}${c.dev ? "; dev-server smoke test" : ""}`);
}
