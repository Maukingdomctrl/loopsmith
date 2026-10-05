// The brush-engine QA and performance pipeline, in one command:
//
//   npm run qa                          the checks the change needs (classify.mjs)
//   npm run qa -- --tier full           everything, on every rendering path
//   npm run qa -- --base <ref>          against another base (default origin/main)
//
//   1. fast    harness syntax; brush precision and cost (npm run brush:check);
//              lint problems the change adds; the production build
//   2. pixels  the brush oracle (every tool, two pacings) and the scenario
//              suite, byte for byte against the base, or against the stored
//              hashes when those cover the base; worker/page parity; the
//              image-path contract; the `next dev` smoke test
//   3. perf    base and head interleaved: main-thread time per stroke,
//              pen-to-screen latency, cost per thread (page, stage worker,
//              compositors), where the page thread's time goes and its
//              dominant stage; then the stored baseline
//
// Writes .qa/<run>/report.md and results.json; exits 1 on a failure or a
// confirmed regression. Options:
//   --tier auto|fast|pixels|perf|full   --paths cpu,gpu,fallback,no-offscreen
//   --quick (fewer repetitions)         --ab (capture the base even when the
//   --jobs <n> (parallel pixel runs)      stored hashes cover it)
//   --out <dir>                         --update-baselines (a full run whose
//                                         head results become the baselines)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserVersion, launch, options, PATHS } from "./lib/env.mjs";
import { build, git, prepareBase, repoRoot, resolveRef, run, serve } from "./lib/serve.mjs";
import { compareDirs, describeDiff, listPngs, pixelDiff, sha256 } from "./lib/png.mjs";
import { median } from "./lib/stats.mjs";
import { loadTrace, penToScreen, stageBreakdown, threadBusy } from "./lib/trace.mjs";
import { changedFiles, classify, TIERS } from "./classify.mjs";
import { describeLint, lintDelta } from "./lint-delta.mjs";

/** A difference counts only past both limits: percent and absolute. */
const THRESHOLDS = {
  mainThread: { pct: 12, abs: 20 }, // ms: median main-thread time per stroke, base vs head
  latency: { pct: 15, abs: 3 }, // ms: pen-to-screen median, base vs head
  latencyP90: { pct: 25, abs: 5 }, // ms: pen-to-screen p90, base vs head
  workerCost: { pct: 25, abs: 20 }, // ms: stage-worker busy time per stroke (warning)
  brushCost: { pct: 40, abs: 50 }, // µs per pointer sample in brush:check (warning; ±25 % between processes)
  stored: { pct: 20 }, // vs the stored baseline, same machine type (warning)
};

const TOOLS = ["hardLine", "softRound", "softRect", "water", "texture", "pencil"];
/** What the perf step runs on the CPU path, by plan (classify.mjs). */
const PLANS = {
  light: { tools: ["hardLine", "pencil"], paces: ["hz"], latency: ["hardLine"], stages: [] },
  full: { tools: ["hardLine", "softRound", "water", "pencil"], paces: ["await", "hz"], latency: ["hardLine", "pencil"], stages: ["hardLine", "pencil"] },
  all: { tools: TOOLS, paces: ["await", "hz"], latency: ["hardLine", "pencil"], stages: ["hardLine", "pencil"] },
};
/** ... and on the fallback path (the stage drawn by the page). */
const SIDE_PLAN = { tools: ["hardLine", "pencil"], paces: ["hz"], latency: ["hardLine"], stages: [] };
/** The threads the reports follow (lib/trace.mjs threadBusy). */
const THREAD_NAMES = { page: "page main thread", stageWorker: "stage worker", rendererCompositor: "renderer compositor", rasterWorkers: "raster workers", displayCompositor: "display compositor (viz)" };
/**
 * GPU raster (SwiftShader) is not bit-exact from run to run: a live preview
 * can land one level apart on a few pixels. On that path only, a difference
 * this small is jitter (a warning); anything larger fails. CPU raster, where
 * the app promises exact pixels, has no tolerance.
 */
const GPU_JITTER = { max: 1, share: 0.0005 };
/** Who must draw the stage on each path. */
const DRAWN_BY = { cpu: "worker", gpu: "worker", fallback: "page", "no-offscreen": "page" };

const QA = path.dirname(fileURLToPath(import.meta.url));
const ROOT = repoRoot();
const BASELINES = path.join(QA, "baselines");
const opt = options();
const started = new Date();
const UPDATE = !!opt("update-baselines", false);
const BASE = String(opt("base", "origin/main"));
const QUICK = !!opt("quick", false);
const FORCE_AB = !!opt("ab", false) || UPDATE;
const JOBS = Math.max(1, Number(opt("jobs", os.cpus().length >= 4 ? 2 : 1)));
const runName = started.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
const OUT = path.resolve(ROOT, String(opt("out", path.join(".qa", runName))));
const LOGS = path.join(OUT, "logs"), RUNS = path.join(OUT, "runs");
fs.mkdirSync(LOGS, { recursive: true });
fs.mkdirSync(RUNS, { recursive: true });

/* ---------------- helpers ---------------- */

const results = { started: started.toISOString(), argv: process.argv.slice(2), thresholds: THRESHOLDS, timings: {}, verdicts: [] };
const say = (s = "") => console.log(s);
const rel = (f) => path.relative(ROOT, f) || ".";
const readJson = (f) => (f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);
const pct = (a, b) => ((b - a) / a) * 100;
const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—");
const signed = (v, d = 1) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}` : "—");
const change = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && a ? `${signed(pct(a, b), 0)}%` : "—");
/** Worse (larger) past both limits. */
const exceeds = (base, head, th) => Number.isFinite(base) && Number.isFinite(head) && head - base >= th.abs && pct(base, head) > th.pct;
/** Better (smaller) past both limits. */
const improves = (base, head, th) => Number.isFinite(base) && Number.isFinite(head) && base - head >= th.abs && pct(head, base) > th.pct;

function verdict(level, area, text) {
  results.verdicts.push({ level, area, text });
  say(`  ${level.padEnd(10)} ${area}: ${text}`);
}
/** An error already reported as a verdict: stop the pipeline. */
class Stop extends Error {}

async function step(name, fn) {
  say(`\n== ${name} ==`);
  const t = Date.now();
  try { await fn(); } finally { results.timings[name] = Math.round((Date.now() - t) / 1000); }
}

/** Runs one of the harness's scripts; its output goes to logs/<label>.log. */
async function script(name, args, label) {
  const log = path.join(LOGS, `${label}.log`);
  const t = Date.now();
  try {
    await run(process.execPath, [path.join(QA, name), ...args], { cwd: ROOT, log });
    return { ok: true, log, seconds: (Date.now() - t) / 1000 };
  } catch (e) {
    return { ok: false, log, seconds: (Date.now() - t) / 1000, error: e.message.split("\n")[0] };
  }
}

/** Runs async jobs `n` at a time, in order. */
async function pool(jobs, n) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) await jobs[next++]();
  }));
}

function simdLevel() {
  if (process.platform !== "linux") return os.cpus()[0]?.model.trim() ?? "?";
  const flags = fs.readFileSync("/proc/cpuinfo", "utf8").match(/^flags\s*:(.*)$/m)?.[1] ?? "";
  return /\bavx512f\b/.test(flags) ? "avx512" : /\bavx2\b/.test(flags) ? "avx2" : /\bavx\b/.test(flags) ? "avx" : "sse";
}

/** Pixels depend on the browser and the CPU's vector unit; timings on the machine. */
const pixelEnv = (e) => (e ? [e.browser, e.platform, e.arch, e.simd].join(" · ") : null);
const perfEnv = (e) => (e ? [e.browser, e.platform, e.arch, e.cpu, `${e.cores} cores`].join(" · ") : null);

/** True when nothing the app draws with changed between two commits (the harness aside). */
function sameApp(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  let files;
  try { files = git(["diff", "--name-only", a, b], ROOT).split("\n").filter(Boolean); } catch { return false; }
  const c = classify(files.filter((f) => !f.startsWith("scripts/qa/")), { mergeBase: a, head: b, root: ROOT });
  return TIERS.indexOf(c.tier) < TIERS.indexOf("pixels");
}

/** `npm run brush:check` in `dir`: every check line, parsed. */
async function brushCheck(dir, label) {
  const log = path.join(LOGS, `brush-check-${label}.log`);
  const sheet = path.join(OUT, `brush-check-${label}.png`);
  let ok = true;
  try {
    await run(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "-s", "brush:check", "--", "--sheet", sheet], { cwd: dir, log });
  } catch { ok = false; }
  const checks = [];
  let section = 0, title = "";
  for (const line of fs.readFileSync(log, "utf8").split("\n")) {
    const sec = line.match(/^(\d+)\. (.*)$/);
    if (sec) { [section, title] = [Number(sec[1]), sec[2].trim()]; continue; }
    const m = line.match(/^\s+(pass|FAIL)\s+(.*?)\s+(-?\d+(?:\.\d+)?)(?: (\S+))?\s+([≤≥])\s+(-?\d+(?:\.\d+)?)/);
    // a section can repeat its labels (§3 runs at two zooms): the key is both
    if (m) checks.push({ section, key: `${section}. ${title} — ${m[2]}`, ok: m[1] === "pass", label: m[2], value: Number(m[3]), unit: m[4] ?? "", lower: m[5] === "≥", limit: Number(m[6]) });
  }
  return { ok: ok && checks.length > 0, checks, log: rel(log), sheet: rel(sheet) };
}
const isCost = (c) => c.section === 11;

/** Hashes of every capture under `dir`, by relative path. */
function hashes(dir) {
  return Object.fromEntries(listPngs(dir).map((f) => [f, sha256(path.join(dir, f)).slice(0, 16)]));
}

/* ---------------- state ---------------- */

const head = {
  sha: git(["rev-parse", "HEAD"], ROOT),
  branch: git(["rev-parse", "--abbrev-ref", "HEAD"], ROOT),
  dirty: git(["status", "--porcelain"], ROOT) !== "",
};
const stored = {
  pixels: readJson(path.join(BASELINES, "pixels.json")),
  perf: readJson(path.join(BASELINES, "perf.json")),
  brush: readJson(path.join(BASELINES, "brush-check.json")),
};
const servers = {};
let env = null, baseSha = null, mergeBase = null, files = [], cls = null;
let tier = "none", plan = null, paths = [], dev = false;
let base = null; // { dir, sha, cached, seconds } once built
const at = (t) => TIERS.indexOf(tier) >= TIERS.indexOf(t);

// started once, whoever asks first
let building = null;
const starting = {};
function ensureBase() {
  return (building ??= (async () => {
    say(`  building the base (${BASE} @ ${baseSha.slice(0, 9)}) in a worktree …`);
    try {
      base = await prepareBase(BASE, { log: path.join(LOGS, "build-base.log") });
    } catch (e) {
      verdict("FAIL", "base build", `${BASE} could not be built: ${e.message.split("\n")[0]} — ${rel(path.join(LOGS, "build-base.log"))}`);
      throw new Stop();
    }
    say(`  base ready${base.cached ? " (cached)" : ` in ${Math.round(base.seconds)} s`}: ${base.dir}`);
    return base;
  })());
}
function server(name) {
  return (starting[name] ??= (async () => {
    const dir = name === "head" ? ROOT : (await ensureBase()).dir;
    servers[name] = await serve(dir, { log: path.join(LOGS, `server-${name}.log`) });
    return servers[name];
  })());
}

/* ---------------- 0. preflight + classification ---------------- */

async function preflight() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) throw new Error(`Node ${process.version}: the pipeline needs Node 20 or newer`);
  for (const m of ["next", "playwright-core", "eslint"]) {
    if (!fs.existsSync(path.join(ROOT, "node_modules", m))) throw new Error(`node_modules/${m} is missing: run npm install`);
  }
  try { baseSha = resolveRef(BASE, ROOT); } catch { throw new Error(`no commit for --base ${BASE} (git fetch origin main?)`); }
  const cpus = os.cpus();
  env = { browser: await browserVersion(), platform: process.platform, arch: process.arch, cpu: cpus[0]?.model.trim() ?? "?", cores: cpus.length, simd: simdLevel(), node: process.version };
  results.env = env;
  results.head = head;
  results.base = { ref: BASE, sha: baseSha };
  say(`head ${head.branch} @ ${head.sha.slice(0, 9)}${head.dirty ? " + uncommitted changes" : ""}; base ${BASE} @ ${baseSha.slice(0, 9)}`);
  say(`Chromium ${env.browser} · ${env.platform} ${env.arch} · ${env.cpu} × ${env.cores} (${env.simd}) · Node ${env.node}`);
}

function classifyChange() {
  ({ mergeBase, files } = changedFiles(BASE, ROOT));
  cls = classify(files, { mergeBase, root: ROOT });
  const asked = UPDATE ? "full" : String(opt("tier", "auto"));
  if (asked === "auto") ({ tier, plan, paths, dev } = cls);
  else if (asked === "full") [tier, plan, paths, dev] = ["perf", "all", [...PATHS], true];
  else if (TIERS.includes(asked)) [tier, plan, paths, dev] = [asked, asked === "perf" ? cls.plan ?? "full" : null, cls.paths, cls.dev];
  else throw new Error(`--tier ${asked}: use auto, fast, pixels, perf or full`);
  if (opt("paths", null)) paths = String(opt("paths")).split(",").filter((p) => PATHS.includes(p));
  if (at("pixels") && !paths.includes("cpu")) paths = ["cpu", ...paths];
  if (!at("pixels")) paths = [];
  results.classification = { asked, tier, plan, paths, dev, mergeBase, files: cls.files, protected: cls.protected };
  say(`${files.length} file(s) changed since the merge base ${mergeBase.slice(0, 9)}:`);
  for (const f of cls.files.slice(0, 40)) say(`  ${f.tier.padEnd(6)} ${f.file} — ${f.why}`);
  if (cls.files.length > 40) say(`  … and ${cls.files.length - 40} more`);
  for (const p of cls.protected) verdict("WARN", "protected file", `${p.file} changed — ${p.note}`);
  say(`tier: ${tier}${plan ? ` (perf plan: ${plan})` : ""}${paths.length ? `; rendering paths: ${paths.join(", ")}` : ""}${dev && at("pixels") ? "; dev-server smoke test" : ""}${asked !== "auto" ? ` (asked for: ${asked})` : ""}`);
}

/* ---------------- 1. fast ---------------- */

async function fast() {
  // the harness itself parses
  const broken = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".mjs") ? [path.join(d, e.name)] : []));
  for (const f of walk(QA)) {
    try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); } catch (e) { broken.push(`${rel(f)}: ${String(e.stderr).trim().split("\n")[0]}`); }
  }
  if (broken.length) verdict("FAIL", "harness", `does not parse: ${broken.join("; ")}`);

  // brush precision and cost, on the head (the base's comes once it is built)
  results.brushCheck = { head: await brushCheck(ROOT, "head") };
  const bc = results.brushCheck.head;
  const failed = bc.checks.filter((c) => !c.ok);
  if (!bc.checks.length) verdict("FAIL", "brush:check", `did not run — ${bc.log}`);
  else if (failed.length || !bc.ok) verdict("FAIL", "brush:check", `${failed.length} check(s) fail: ${failed.map((c) => `${c.label} = ${c.value}${c.unit} (limit ${c.limit})`).join("; ") || `see ${bc.log}`}`);
  else verdict("PASS", "brush:check", `${bc.checks.length} checks pass (${bc.checks.filter((c) => !isCost(c)).length} precision, ${bc.checks.filter(isCost).length} cost)`);

  // lint problems the change adds
  results.lint = await lintDelta(files, mergeBase, ROOT);
  const ld = results.lint;
  const list = ld.problems.slice(0, 8).map((p) => `${p.file}:${p.lines[0]} ${p.rule}`).join("; ");
  if (ld.newErrors) verdict("FAIL", "lint", `${describeLint(ld)} — ${list}`);
  else if (ld.newWarnings) verdict("WARN", "lint", `${describeLint(ld)} — ${list}`);
  else verdict("PASS", "lint", describeLint(ld));

  // the production build (and the base's, alongside, when the next steps need it)
  const needBase = at("perf") || (at("pixels") && basePixelPaths().length > 0);
  say("  building the head (next build --no-mangling) …");
  const headBuild = build(ROOT, { log: path.join(LOGS, "build-head.log") }).then((s) => ({ s }), (e) => ({ e }));
  const baseBuild = needBase ? ensureBase().then(() => null, (e) => e) : null;
  const hb = await headBuild;
  results.build = { ok: !hb.e, seconds: hb.s ? Math.round(hb.s) : null, log: rel(path.join(LOGS, "build-head.log")) };
  if (hb.e) {
    verdict("FAIL", "build", `next build failed — ${results.build.log}\n${hb.e.message.split("\n").slice(-12).join("\n")}`);
    await baseBuild;
    throw new Stop();
  }
  verdict("PASS", "build", `next build --no-mangling passes (type check included), ${Math.round(hb.s)} s`);
  const be = baseBuild && (await baseBuild);
  if (be) throw be;
  if (base) {
    results.brushCheck.base = await brushCheck(base.dir, "base");
    // timings that look slower get two more runs on both sides, interleaved;
    // the fastest run counts (the machine only ever adds time)
    const cost = (r) => new Map(r.checks.filter(isCost).map((c) => [c.key, c]));
    const hc = cost(bc), bcost = cost(results.brushCheck.base);
    if ([...hc].some(([k, c]) => exceeds(bcost.get(k)?.value, c.value, THRESHOLDS.brushCost))) {
      say("  brush cost looks slower: measuring both sides twice more …");
      for (const [side, dir, map] of [["base", base.dir, bcost], ["head", ROOT, hc], ["head", ROOT, hc], ["base", base.dir, bcost]]) {
        for (const c of (await brushCheck(dir, `${side}-${Date.now()}`)).checks.filter(isCost)) {
          const was = map.get(c.key);
          if (was) was.value = Math.min(was.value, c.value);
        }
      }
    }
  }
  brushVerdicts();
}

function brushVerdicts() {
  const h = results.brushCheck.head, b = results.brushCheck.base;
  const ref = b?.checks.length ? { name: `the base`, checks: b.checks }
    : stored.brush ? { name: `the stored baseline (${stored.brush.commit.slice(0, 9)})`, checks: stored.brush.checks } : null;
  if (!ref) return;
  const byKey = new Map(ref.checks.map((c) => [c.key, c]));
  const moved = [];
  for (const c of h.checks.filter((c) => !isCost(c))) {
    const r = byKey.get(c.key);
    if (r && r.value !== c.value) moved.push({ label: `§${c.section} ${c.label}`, from: r.value, to: c.value, unit: c.unit, worse: c.lower ? c.value < r.value : c.value > r.value });
  }
  results.brushCheck.precisionChanges = { against: ref.name, moved };
  const worse = moved.filter((m) => m.worse);
  if (worse.length) verdict("WARN", "brush precision", `${worse.length} measure(s) worse than ${ref.name}, still within limits: ${worse.map((m) => `${m.label} ${m.from} → ${m.to}${m.unit}`).join("; ")}`);
  else if (moved.length) verdict("INFO", "brush precision", `${moved.length} measure(s) better than ${ref.name}`);
  else verdict("PASS", "brush precision", `every precision measure equals ${ref.name}`);
  // cost per pointer sample: against the base (same machine, minutes apart),
  // else the stored baseline on the same kind of machine
  const costRef = b?.checks.length ? { name: "the base", checks: b.checks }
    : stored.brush && perfEnv(stored.brush.env) === perfEnv(env) ? { name: "the stored baseline", checks: stored.brush.checks } : null;
  if (!costRef) return;
  const refCost = new Map(costRef.checks.filter(isCost).map((c) => [c.key, c.value]));
  const rows = h.checks.filter(isCost).map((c) => ({ label: c.label, base: refCost.get(c.key), head: c.value }));
  results.brushCheck.cost = { against: costRef.name, rows };
  const slow = rows.filter((r) => exceeds(r.base, r.head, THRESHOLDS.brushCost));
  if (slow.length) verdict("WARN", "brush cost", `slower than ${costRef.name}: ${slow.map((r) => `${r.label} ${fmt(r.base, 0)} → ${fmt(r.head, 0)} µs`).join("; ")} (brush:check measures 3 runs; re-run to confirm)`);
}

/* ---------------- 2. pixels ---------------- */

const storedPixelsUsable = () => {
  const s = stored.pixels;
  return !!s && pixelEnv(s.env) === pixelEnv(env) && sameApp(s.commit, baseSha);
};
/** Paths whose base captures are needed up front: CPU and GPU (fallback and
 *  no-offscreen are checked against the head's CPU captures). */
function basePixelPaths() {
  const usable = storedPixelsUsable();
  return paths.filter((p) => (p === "cpu" || p === "gpu") && (FORCE_AB || !usable || !stored.pixels.paths?.[p]));
}

async function pixels() {
  const oraclePaces = QUICK ? ["await"] : ["await", "hz"];
  const captured = [...TOOLS.flatMap((t) => oraclePaces.map((p) => `oracle/${t}-${p}/`)), "scenarios/"];
  const runs = [];
  results.pixels = { runs, compare: {} };
  const suite = (b, p) => {
    const dir = path.join(OUT, "pixels", b, p);
    const jobs = TOOLS.flatMap((tool) => oraclePaces.map((pace) => async () => {
      const label = `oracle-${b}-${p}-${tool}-${pace}`, json = path.join(RUNS, `${label}.json`);
      const r = await script("stroke.mjs", ["--url", (await server(b)).url, "--brush", tool, "--pace", pace, "--strokes", "2", "--path", p, "--pixels", path.join(dir, "oracle", `${tool}-${pace}`), "--out", json], label);
      const out = readJson(json);
      runs.push({ build: b, path: p, what: `oracle ${tool} ${pace}`, ok: r.ok && !!out, drawnBy: out?.stage?.drawnBy ?? null, errors: out?.errors ?? [], log: rel(r.log) });
      say(`  ${r.ok ? "ok  " : "FAIL"} ${b} ${p} oracle ${tool} ${pace} (${Math.round(r.seconds)} s)`);
    }));
    jobs.push(async () => {
      const label = `scenarios-${b}-${p}`, sdir = path.join(dir, "scenarios");
      const r = await script("scenarios.mjs", ["--url", (await server(b)).url, "--path", p, "--out", sdir], label);
      const sum = readJson(path.join(sdir, "summary.json"));
      for (const [name, s] of Object.entries(sum?.sessions ?? {})) {
        runs.push({ build: b, path: p, what: `scenario ${name}`, ok: !s.failed, failed: s.failed, drawnBy: s.drawnBy, errors: s.errors, log: rel(r.log) });
      }
      if (!sum) runs.push({ build: b, path: p, what: "scenarios", ok: false, failed: r.error, errors: [], log: rel(r.log) });
      say(`  ${r.ok ? "ok  " : "FAIL"} ${b} ${p} scenarios (${Math.round(r.seconds)} s)`);
    });
    return jobs;
  };
  const dirOf = (b, p) => path.join(OUT, "pixels", b, p);

  // head on every path; the base where its captures are needed — interleaved
  // so that `--jobs 2` runs one of each side by side
  const wanted = basePixelPaths();
  await server("head");
  const jobs = [];
  for (const p of paths) {
    const h = suite("head", p), b = wanted.includes(p) ? suite("base", p) : [];
    for (let i = 0; i < Math.max(h.length, b.length); i++) jobs.push(...[h[i], b[i]].filter(Boolean));
  }
  say(`  ${jobs.length} runs, ${JOBS} at a time (head: ${paths.join(", ")}; base: ${wanted.join(", ") || "stored hashes"})`);
  await pool(jobs, JOBS);

  // a head capture that differs from stored hashes covering the base: capture
  // the base too, so that the verdict rests on a direct comparison
  const usable = storedPixelsUsable();
  const storedCmp = (p, dir) => {
    const s = stored.pixels?.paths?.[p];
    if (!s || pixelEnv(stored.pixels.env) !== pixelEnv(env)) return null;
    const now = hashes(dir);
    const names = new Set([...Object.keys(s).filter((f) => captured.some((c) => f.startsWith(c))), ...Object.keys(now)]);
    const out = { identical: [], different: [], missing: [], extra: [] };
    for (const f of [...names].sort()) {
      if (!(f in now)) out.missing.push(f);
      else if (!(f in s)) out.extra.push(f);
      else (now[f] === s[f] ? out.identical : out.different).push(f);
    }
    return out;
  };
  // (a capture new on the head has nothing to differ from: it does not call
  // for the base)
  const late = paths.filter((p) => !wanted.includes(p) && (p === "cpu" || p === "gpu") && usable && (() => {
    const c = storedCmp(p, dirOf("head", p));
    return !c || c.different.length || c.missing.length;
  })());
  if (late.length) {
    say(`  head differs from the stored hashes on ${late.join(", ")}: capturing the base there too …`);
    await pool(late.flatMap((p) => suite("base", p)), JOBS);
  }

  // runs that failed, logged page errors, or put the stage on the wrong path:
  // one verdict per kind of problem
  const problems = new Map();
  for (const r of runs) {
    const wrongPath = r.build === "head" && r.drawnBy && r.drawnBy !== DRAWN_BY[r.path];
    const [kind, why] = !r.ok ? ["failed", r.failed ?? ""] : r.errors?.length ? ["logged page errors", r.errors.slice(0, 2).join(" | ")] : wrongPath ? [`drew the stage on the ${r.drawnBy}, not the ${DRAWN_BY[r.path]}`, ""] : [];
    if (!kind) continue;
    const k = `${r.build}|${r.path}|${kind}`;
    (problems.get(k) ?? problems.set(k, []).get(k)).push({ ...r, why });
  }
  for (const [k, list] of problems) {
    const [b, p, kind] = k.split("|");
    const of = runs.filter((r) => r.build === b && r.path === p).length;
    const examples = list.slice(0, 3).map((r) => `${r.what}${r.why ? ` (${r.why})` : ""} — ${r.log}`).join("; ");
    verdict(b === "head" ? "FAIL" : "WARN", `pixels ${p}`, `${list.length} of ${of} ${b} runs ${kind}: ${examples}${list.length > 3 ? "; …" : ""}`);
  }

  // comparisons: head vs base, head vs stored hashes, worker vs page
  const browser = await launch();
  const page = await (await browser.newContext()).newPage();
  const detail = async (a, b, list) => {
    const out = [];
    for (const f of list.slice(0, 12)) out.push({ file: f, diff: describeDiff(await pixelDiff(page, path.join(a, f), path.join(b, f))) });
    return out;
  };
  const describeList = (d) => d.map((x) => `${x.file} (${x.diff})`).join("; ");
  const isJitter = (d) => !d.sizeMismatch && d.max <= GPU_JITTER.max && d.pixels / (d.width * d.height) <= GPU_JITTER.share;
  for (const p of paths) {
    const c = (results.pixels.compare[p] = {});
    const H = dirOf("head", p), B = dirOf("base", p);
    c.captures = listPngs(H).length;
    if (fs.existsSync(B)) {
      const r = compareDirs(B, H);
      // on GPU raster, every difference is measured to tell jitter from change
      const jitter = [], real = [];
      for (const f of p === "gpu" ? r.different : []) {
        const d = await pixelDiff(page, path.join(B, f), path.join(H, f));
        (isJitter(d) ? jitter : real).push({ file: f, diff: describeDiff(d) });
      }
      const changed = p === "gpu" ? real.map((x) => x.file) : r.different;
      c.base = { identical: r.identical.length, different: changed, jitter: jitter.map((x) => x.file), onlyBase: r.onlyA, onlyHead: r.onlyB, details: p === "gpu" ? real.slice(0, 12) : await detail(B, H, r.different) };
      // a capture only the head makes (a new scenario step) has no reference
      // yet: reported, and recorded with the next baselines
      const n = changed.length + r.onlyA.length;
      const total = r.identical.length + r.different.length + r.onlyA.length;
      if (n) verdict("FAIL", `pixels ${p}`, `${n} of ${total} captures differ from the base: ${describeList(c.base.details)}${r.onlyA.length ? `; missing on the head: ${r.onlyA.slice(0, 5).join(", ")}` : ""}`);
      else verdict("PASS", `pixels ${p}`, `${r.identical.length} captures byte-identical to the base${jitter.length ? `, ${jitter.length} within GPU raster jitter` : ""}`);
      if (r.onlyB.length) verdict("INFO", `pixels ${p}`, `${r.onlyB.length} new capture(s) the base cannot make (new scenario steps), nothing to compare yet — record the baselines after the merge: ${r.onlyB.slice(0, 6).join(", ")}${r.onlyB.length > 6 ? ", …" : ""}`);
      if (jitter.length) verdict("WARN", `pixels ${p}`, `${jitter.length} capture(s) differ from the base by GPU raster jitter only (≤ ${GPU_JITTER.max} level on ≤ ${GPU_JITTER.share * 100} % of pixels): ${describeList(jitter.slice(0, 6))}`);
    }
    const sc = storedCmp(p, H);
    if (sc) {
      c.stored = { identical: sc.identical.length, different: sc.different, missing: sc.missing, extra: sc.extra };
      const n = sc.different.length + sc.missing.length;
      if (!fs.existsSync(B) && usable) {
        if (n) verdict("FAIL", `pixels ${p}`, `${n} of ${sc.identical.length + n} captures differ from the stored baseline`);
        else verdict("PASS", `pixels ${p}`, `${sc.identical.length} captures byte-identical to the stored baseline (recorded at ${stored.pixels.commit.slice(0, 9)}, the same app as the base)`);
        if (sc.extra.length) verdict("INFO", `pixels ${p}`, `${sc.extra.length} new capture(s) the stored baseline does not have (new scenario steps), nothing to compare yet — record the baselines after the merge: ${sc.extra.slice(0, 6).join(", ")}${sc.extra.length > 6 ? ", …" : ""}`);
      } else if (fs.existsSync(B)) {
        const bs = storedCmp(p, B);
        const stale = bs && bs.different.length + bs.missing.length + bs.extra.length;
        if (stale) verdict("WARN", `pixels ${p}`, p === "gpu"
          ? `the base differs from the stored GPU hashes in ${stale} capture(s): GPU raster jitter, or a stored baseline out of date (re-record it on main if this persists)`
          : `the stored baseline is out of date: the base itself differs from it in ${stale} capture(s) — re-record it on main (npm run qa:baselines)`);
      }
    }
    if (p === "fallback" || p === "no-offscreen") {
      const r = compareDirs(dirOf("head", "cpu"), H);
      c.parity = { identical: r.identical.length, different: r.different, details: await detail(dirOf("head", "cpu"), H, r.different) };
      const n = r.different.length + r.onlyA.length + r.onlyB.length;
      if (n) verdict("FAIL", `parity ${p}`, `the stage drawn by the page differs from the worker's (cpu) in ${n} capture(s): ${describeList(c.parity.details)}`);
      else verdict("PASS", `parity ${p}`, `${r.identical.length} captures identical to the worker-drawn stage (cpu)`);
    }
  }
  await browser.close();

  // the image-path contract the worker's image drawing rests on
  const ip = await script("image-path.mjs", [], "image-path");
  const text = fs.readFileSync(ip.log, "utf8");
  const m = text.match(/(\d+) of (\d+) cases identical/);
  const which = text.match(/take the (\w+) path/)?.[1];
  results.pixels.imagePath = { ok: ip.ok, identical: Number(m?.[1]), cases: Number(m?.[2]), path: which, log: rel(ip.log) };
  if (!ip.ok) verdict("FAIL", "image-path contract", `${m ? `${m[1]}/${m[2]}` : "?"} cases identical on CPU raster: the worker no longer draws decoded images as the page does — ${rel(ip.log)}`);
  else verdict(which === "CPU" ? "PASS" : "INFO", "image-path contract", which === "CPU" ? `${m[1]}/${m[2]} cases identical (page <img> vs worker ImageBitmap with emulated mip levels)` : `decoded images take the ${which} path on this browser: the contract applies to CPU raster only`);

  // React Strict Mode mounts the stage twice in development
  if (dev) {
    const srv = await serve(ROOT, { dev: true, log: path.join(LOGS, "server-dev.log") });
    try {
      const r = await script("dev-smoke.mjs", ["--url", srv.url], "dev-smoke");
      const last = fs.readFileSync(r.log, "utf8").trim().split("\n");
      results.pixels.devSmoke = { ok: r.ok, output: last, log: rel(r.log) };
      verdict(r.ok ? "PASS" : "FAIL", "dev smoke", `${last[0]}${r.ok ? "" : ` — ${last.slice(1).join(" | ")}`}`);
    } finally { srv.stop(); }
  }
}

/* ---------------- 3. perf ---------------- */

async function perf() {
  const strokes = QUICK ? 4 : 6, latencyRuns = QUICK ? 2 : 3;
  const perfPaths = ["cpu", ...paths.filter((p) => p === "fallback")];
  const planFor = (p) => (p === "cpu" ? PLANS[plan ?? "full"] : SIDE_PLAN);
  await server("base");
  await server("head");
  let n = 0;
  const strokeRun = async (b, p, tool, pace, extra = [], count = strokes) => {
    const label = `${extra.length ? "traced" : "bench"}-${b}-${p}-${tool}-${pace}-${++n}`;
    const json = path.join(RUNS, `${label}.json`);
    const r = await script("stroke.mjs", ["--url", servers[b].url, "--brush", tool, "--pace", pace, "--strokes", String(count), "--path", p, "--out", json, ...extra.map((x) => x.replace("%", label))], label);
    const out = readJson(json);
    if (!r.ok || !out?.summary) {
      verdict("FAIL", "perf", `${b} ${p} ${tool} ${pace}: the run failed — ${rel(r.log)}`);
      return null;
    }
    if (out.errors?.length) verdict("FAIL", "perf", `${b} ${p} ${tool} ${pace}: page errors: ${out.errors.slice(0, 2).join(" | ")}`);
    return { out, label };
  };

  // main-thread time per stroke, base and head interleaved (the order flips
  // between configurations so drift in the machine favours neither)
  const bench = (results.perf = { bench: {}, latency: {}, stages: {} }).bench;
  const summarize = (list) => ({
    strokes: list.length,
    task: median(list.map((s) => s.task)),
    during: median(list.map((s) => s.during)),
    after: median(list.map((s) => s.task - s.during)),
    wall: median(list.map((s) => s.wall)),
  });
  const benchPair = async (e, order) => {
    for (const b of order) {
      const r = await strokeRun(b, e.path, e.tool, e.pace);
      if (r) for (const s of r.out.results.slice(1)) e.samples[b].push({ task: s.marks.task, during: s.marks.during, wall: s.marks.upSent - s.marks.start });
    }
    e.base = summarize(e.samples.base);
    e.head = summarize(e.samples.head);
  };
  let flip = false;
  for (const p of perfPaths) {
    for (const tool of planFor(p).tools) for (const pace of planFor(p).paces) {
      const e = (bench[`${p} ${tool} ${pace}`] = { path: p, tool, pace, samples: { base: [], head: [] } });
      await benchPair(e, (flip = !flip) ? ["base", "head"] : ["head", "base"]);
      say(`  ${p} ${tool.padEnd(9)} ${pace.padEnd(5)} main thread ${fmt(e.base.task, 0)} → ${fmt(e.head.task, 0)} ms (${change(e.base.task, e.head.task)})`);
    }
  }
  for (const [key, e] of Object.entries(bench)) {
    if (!exceeds(e.base.task, e.head.task, THRESHOLDS.mainThread)) continue;
    say(`  ${key}: ${change(e.base.task, e.head.task)} — confirming with two more runs each …`);
    e.firstLook = { base: e.base.task, head: e.head.task };
    await benchPair(e, ["head", "base", "base", "head"]);
    say(`  ${key}: ${fmt(e.base.task, 0)} → ${fmt(e.head.task, 0)} ms (${change(e.base.task, e.head.task)}) over ${e.head.strokes} strokes each`);
  }

  // pen-to-screen latency and cost per thread, from traces (hz pacing)
  const latency = results.perf.latency;
  const latencyRun = async (e, b) => {
    const r = await strokeRun(b, e.path, e.tool, "hz", ["--trace", path.join(RUNS, "%.trace.json")], 2);
    if (!r) return;
    const trace = path.join(RUNS, `${r.label}.trace.json`);
    const ev = loadTrace(trace);
    const lat = penToScreen(ev);
    if (!lat.events) verdict("WARN", "latency", `${b} ${e.path} ${e.tool}: no pen movement matched in ${rel(trace)}`);
    else e.runs[b].push({ ...lat, threads: threadBusy(ev).keyThreads });
    // one trace per side is kept for threads.mjs / latency.mjs; the rest are 15+ MB each
    if (e.kept[b]) fs.rmSync(trace, { force: true });
    else e.kept[b] = rel(trace);
  };
  const latSummary = (list) => ({
    runs: list.length,
    median: median(list.map((r) => r.median)),
    p90: median(list.map((r) => r.p90)),
    toFrame: median(list.map((r) => r.toFrame)),
    toSwap: median(list.map((r) => r.toSwap)),
    stage: list[0]?.stage ?? null,
    threads: Object.fromEntries(Object.keys(list[0]?.threads ?? {}).map((k) => [k, median(list.map((r) => r.threads[k]))])),
  });
  for (const p of perfPaths) for (const tool of planFor(p).latency) {
    const e = (latency[`${p} ${tool}`] = { path: p, tool, runs: { base: [], head: [] }, kept: {} });
    for (let i = 0; i < latencyRuns; i++) for (const b of i % 2 ? ["head", "base"] : ["base", "head"]) await latencyRun(e, b);
    e.base = latSummary(e.runs.base);
    e.head = latSummary(e.runs.head);
    if (exceeds(e.base.median, e.head.median, THRESHOLDS.latency) || exceeds(e.base.p90, e.head.p90, THRESHOLDS.latencyP90)) {
      say(`  ${p} ${tool} latency ${fmt(e.base.median)} → ${fmt(e.head.median)} ms — confirming with two more runs each …`);
      e.firstLook = { base: e.base.median, head: e.head.median };
      for (const b of ["head", "base", "base", "head"]) await latencyRun(e, b);
      e.base = latSummary(e.runs.base);
      e.head = latSummary(e.runs.head);
    }
    say(`  ${p} ${tool.padEnd(9)} pen → screen median ${fmt(e.base.median)} → ${fmt(e.head.median)} ms, p90 ${fmt(e.base.p90)} → ${fmt(e.head.p90)} ms`);
  }

  // where the page thread's time goes: CPU profile + trace of one stroke
  for (const tool of (planFor("cpu").stages ?? [])) {
    const e = (results.perf.stages[`cpu ${tool}`] = { tool });
    for (const b of ["base", "head"]) {
      const r = await strokeRun(b, "cpu", tool, "hz", ["--trace", path.join(RUNS, "%.trace.json"), "--cpuprofile", path.join(RUNS, "%.cpu.json")], 2);
      if (!r) continue;
      const last = r.out.results.at(-1).marks;
      const files = { trace: path.join(RUNS, `${r.label}.trace.json`), cpu: path.join(RUNS, `${r.label}.cpu.json`) };
      e[b] = { ...stageBreakdown(readJson(files.cpu), last.upSent - last.start, loadTrace(files.trace)), trace: rel(files.trace), cpuprofile: rel(files.cpu) };
    }
    if (e.head) say(`  ${tool}: dominant stage on the page thread: ${e.head.dominant.stage} (${fmt(e.head.dominant.ms)} ms of ${fmt(e.head.mainThreadMs)} ms)`);
  }

  perfVerdicts();
}

function perfVerdicts() {
  const { bench, latency, stages } = results.perf;
  for (const [key, e] of Object.entries(bench)) {
    const d = `${fmt(e.base.task, 0)} → ${fmt(e.head.task, 0)} ms (${change(e.base.task, e.head.task)})`;
    if (exceeds(e.base.task, e.head.task, THRESHOLDS.mainThread)) verdict("REGRESSION", "main thread", `${key}: ${d}${e.firstLook ? ", confirmed by a second round" : ""}`);
    else if (e.firstLook) verdict("INFO", "main thread", `${key}: first round ${fmt(e.firstLook.base, 0)} → ${fmt(e.firstLook.head, 0)} ms, not confirmed (${d} over all runs)`);
    else if (improves(e.base.task, e.head.task, THRESHOLDS.mainThread)) verdict("INFO", "main thread", `${key}: faster, ${d}`);
  }
  const worse = Object.values(bench).filter((e) => exceeds(e.base.task, e.head.task, THRESHOLDS.mainThread));
  if (!worse.length && Object.keys(bench).length) verdict("PASS", "main thread", `no regression in ${Object.keys(bench).length} configuration(s) (limit +${THRESHOLDS.mainThread.pct}% and +${THRESHOLDS.mainThread.abs} ms)`);
  for (const [key, e] of Object.entries(latency)) {
    const d = `median ${fmt(e.base.median)} → ${fmt(e.head.median)} ms, p90 ${fmt(e.base.p90)} → ${fmt(e.head.p90)} ms`;
    if (exceeds(e.base.median, e.head.median, THRESHOLDS.latency) || exceeds(e.base.p90, e.head.p90, THRESHOLDS.latencyP90)) verdict("REGRESSION", "latency", `${key}: ${d}${e.firstLook ? ", confirmed by a second round" : ""}`);
    else verdict("PASS", "latency", `${key}: ${d}`);
    const w = [e.base.threads?.stageWorker, e.head.threads?.stageWorker];
    if (!w[0] && w[1] > 0) verdict("INFO", "stage worker", `${key}: the base has no stage worker; the head's is busy ${fmt(w[1], 0)} ms per stroke`);
    else if (exceeds(w[0], w[1], THRESHOLDS.workerCost)) verdict("WARN", "stage worker", `${key}: busy ${fmt(w[0], 0)} → ${fmt(w[1], 0)} ms per stroke (${change(...w)})`);
  }
  const s = Object.values(stages).find((x) => x.head);
  if (s) {
    const threads = latency[`cpu ${s.tool}`]?.head.threads ?? {};
    const busiest = Object.entries(threads).sort((a, b) => b[1] - a[1])[0];
    results.perf.bottleneck = { tool: s.tool, stage: s.head.dominant, thread: busiest ? { name: busiest[0], ms: busiest[1] } : null };
    verdict("INFO", "bottleneck", `${s.tool}: the page thread's largest stage is ${s.head.dominant.stage} (${fmt(s.head.dominant.ms)} of ${fmt(s.head.mainThreadMs)} ms)${busiest ? `; the busiest thread while drawing is the ${THREAD_NAMES[busiest[0]] ?? busiest[0]} (${fmt(busiest[1], 0)} ms)` : ""}`);
  }
  // the stored baseline, when it was recorded on the same kind of machine
  const sp = stored.perf;
  if (!sp) return;
  const same = perfEnv(sp.env) === perfEnv(env);
  results.perf.stored = { commit: sp.commit, recorded: sp.recorded, sameMachine: same, sameApp: sameApp(sp.commit, baseSha), drift: [] };
  if (!same) { verdict("INFO", "stored perf baseline", `recorded on ${perfEnv(sp.env)}: not compared on this machine`); return; }
  for (const [key, e] of Object.entries(bench)) {
    const was = sp.bench?.[key]?.task;
    if (was && pct(was, e.head.task) > THRESHOLDS.stored.pct) results.perf.stored.drift.push(`${key} main thread ${fmt(was, 0)} → ${fmt(e.head.task, 0)} ms`);
  }
  for (const [key, e] of Object.entries(latency)) {
    const was = sp.latency?.[key]?.median;
    if (was && pct(was, e.head.median) > THRESHOLDS.stored.pct) results.perf.stored.drift.push(`${key} latency ${fmt(was)} → ${fmt(e.head.median)} ms`);
  }
  const drift = results.perf.stored.drift;
  if (drift.length) verdict("WARN", "stored perf baseline", `slower than when recorded (${sp.commit.slice(0, 9)}, ${sp.recorded.slice(0, 10)}) by more than ${THRESHOLDS.stored.pct}%: ${drift.join("; ")}${results.perf.stored.sameApp ? "" : " — the base has changed since then"}`);
  else verdict("PASS", "stored perf baseline", `within ${THRESHOLDS.stored.pct}% of the numbers recorded at ${sp.commit.slice(0, 9)}`);
}

/* ---------------- report ---------------- */

function report() {
  const L = [];
  const v = results.verdicts;
  const order = ["FAIL", "REGRESSION", "WARN", "PASS", "INFO"];
  const count = (l) => v.filter((x) => x.level === l).length;
  const failed = count("FAIL") + count("REGRESSION");
  const status = failed ? "FAIL" : count("WARN") ? "PASS with warnings" : "PASS";
  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  L.push(`# QA report: ${status}`, "");
  L.push(`- **Head:** \`${head.branch}\` @ ${head.sha.slice(0, 9)}${head.dirty ? " + uncommitted changes" : ""}`);
  L.push(`- **Base:** \`${BASE}\` @ ${baseSha?.slice(0, 9) ?? "?"}${base ? ` (built in ${base.dir})` : ""}`);
  if (env) L.push(`- **Machine:** Chromium ${env.browser} · ${env.platform} ${env.arch} · ${env.cpu} × ${env.cores} (${env.simd}) · Node ${env.node}`);
  L.push(`- **Tier:** ${tier}${plan ? ` (perf plan: ${plan})` : ""}${paths.length ? ` · paths: ${paths.join(", ")}` : ""} · ${files.length} changed file(s)`);
  L.push(`- **Run:** ${started.toISOString().slice(0, 16).replace("T", " ")} UTC, ${minutes} min · \`${rel(OUT)}\``, "");
  L.push("## Verdicts", "");
  for (const l of order) for (const x of v.filter((y) => y.level === l)) L.push(`- **${x.level}** ${x.area}: ${x.text.replace(/\n/g, " ")}`);
  if (!v.length) L.push("- nothing to check");
  L.push("");
  if (cls?.files.length) {
    L.push("## Changed files", "", "| File | Tier | Why |", "|---|---|---|");
    for (const f of cls.files.slice(0, 60)) L.push(`| \`${f.file}\` | ${f.tier}${f.plan ? ` (${f.plan})` : ""} | ${f.why} |`);
    if (cls.files.length > 60) L.push(`| … ${cls.files.length - 60} more | | |`);
    L.push("");
  }
  if (results.brushCheck) {
    const bc = results.brushCheck;
    L.push("## Fast checks", "");
    L.push(`- build: ${results.build?.ok ? `passes (${results.build.seconds} s)` : `**failed**`} — \`${results.build?.log ?? ""}\``);
    L.push(`- brush:check: ${bc.head.checks.filter((c) => c.ok).length}/${bc.head.checks.length} pass — \`${bc.head.log}\`, sheet \`${bc.head.sheet}\``);
    if (bc.precisionChanges) L.push(`- precision vs ${bc.precisionChanges.against}: ${bc.precisionChanges.moved.length ? bc.precisionChanges.moved.map((m) => `${m.label} ${m.from} → ${m.to}${m.unit}${m.worse ? " (worse)" : ""}`).join("; ") : "identical"}`);
    if (results.lint) L.push(`- lint: ${describeLint(results.lint)}`);
    if (bc.cost) {
      L.push("", `Cost per pointer sample (brush:check §11, µs), ${bc.cost.against} → head:`, "", "| Case | Before | After | Change |", "|---|---:|---:|---:|");
      for (const r of bc.cost.rows) L.push(`| ${r.label} | ${fmt(r.base, 0)} | ${fmt(r.head, 0)} | ${change(r.base, r.head)} |`);
    }
    L.push("");
  }
  if (results.pixels) {
    L.push("## Pixels", "", "| Path | Captures | vs base | vs stored baseline | Parity with the worker (cpu) |", "|---|---:|---|---|---|");
    for (const [p, c] of Object.entries(results.pixels.compare)) {
      const ab = c.base ? `${c.base.different.length + c.base.onlyBase.length ? `**${c.base.different.length + c.base.onlyBase.length} differ**` : `${c.base.identical} identical${c.base.jitter?.length ? `, ${c.base.jitter.length} jitter` : ""}`}${c.base.onlyHead.length ? `, ${c.base.onlyHead.length} new` : ""}` : "—";
      const st = c.stored ? `${c.stored.different.length + c.stored.missing.length ? `${c.stored.different.length + c.stored.missing.length} differ` : `${c.stored.identical} identical`}${c.stored.extra.length ? `, ${c.stored.extra.length} new` : ""}` : "—";
      const par = c.parity ? (c.parity.different.length ? `**${c.parity.different.length} differ**` : `${c.parity.identical} identical`) : "—";
      L.push(`| ${p} | ${c.captures} | ${ab} | ${st} | ${par} |`);
    }
    const diffs = Object.entries(results.pixels.compare).flatMap(([p, c]) => [...(c.base?.details ?? []), ...(c.parity?.details ?? [])].map((d) => `- ${p}: \`${d.file}\` — ${d.diff}`));
    if (diffs.length) L.push("", "Differences (look at one with `node scripts/qa/pngdiff.mjs A B --viz out.png`):", "", ...diffs);
    const ip = results.pixels.imagePath;
    if (ip) L.push("", `Image-path contract: ${ip.identical}/${ip.cases} identical; decoded images take the ${ip.path} path.`);
    if (results.pixels.devSmoke) L.push(`Dev server smoke test: ${results.pixels.devSmoke.output.join(" · ")}`);
    L.push("");
  }
  if (results.perf) {
    const { bench, latency, stages } = results.perf;
    L.push("## Performance (base → head, medians)", "");
    L.push("Main-thread time per stroke of 241 pen events, split into the stroke (pen-down → pen-up) and the commit after pen-up; median of warm strokes. Pace `await`: one event per frame, so the stroke's wall time is 241 frames (≈ 4.0 s at 60 Hz) unless frames are missed; `hz`: 240 Hz real time.", "");
    L.push("| Path | Tool | Pace | Base ms | Head ms | Change | Stroke | Commit | Wall time (await) |", "|---|---|---|---:|---:|---:|---|---|---|");
    for (const e of Object.values(bench)) {
      L.push(`| ${e.path} | ${e.tool} | ${e.pace} | ${fmt(e.base.task, 0)} | ${fmt(e.head.task, 0)} | ${change(e.base.task, e.head.task)} | ${fmt(e.base.during, 0)} → ${fmt(e.head.during, 0)} | ${fmt(e.base.after, 0)} → ${fmt(e.head.after, 0)} | ${e.pace === "await" ? `${fmt(e.base.wall, 0)} → ${fmt(e.head.wall, 0)} ms` : "—"} |`);
    }
    if (Object.keys(latency).length) {
      L.push("", "Pen movement → on screen (traced, 240 Hz; mean split into its two legs):", "");
      L.push("| Path | Tool | Stage drawn by | Median | p90 | Mean legs: to display compositor + to screen |", "|---|---|---|---|---|---|");
      for (const e of Object.values(latency)) {
        L.push(`| ${e.path} | ${e.tool} | ${e.base.stage} → ${e.head.stage} | ${fmt(e.base.median)} → ${fmt(e.head.median)} ms (${change(e.base.median, e.head.median)}) | ${fmt(e.base.p90)} → ${fmt(e.head.p90)} ms | ${fmt(e.base.toFrame)} + ${fmt(e.base.toSwap)} → ${fmt(e.head.toFrame)} + ${fmt(e.head.toSwap)} ms |`);
      }
      L.push("", "Busy time per thread while drawing (pen-down → pen-up, ms):", "");
      L.push(`| Thread | ${Object.values(latency).map((e) => `${e.path} ${e.tool}`).join(" | ")} |`, `|---|${Object.values(latency).map(() => "---").join("|")}|`);
      for (const [k, name] of Object.entries(THREAD_NAMES)) L.push(`| ${name} | ${Object.values(latency).map((e) => `${fmt(e.base.threads?.[k], 0)} → ${fmt(e.head.threads?.[k], 0)}`).join(" | ")} |`);
      const kept = Object.values(latency).flatMap((e) => Object.entries(e.kept).map(([b, f]) => `\`${f}\` (${b})`));
      if (kept.length) L.push("", `Traces kept for \`threads.mjs\` / \`latency.mjs\`: ${kept.join(", ")}`);
    }
    for (const e of Object.values(stages)) {
      if (!e.head) continue;
      L.push("", `Where a ${e.tool} stroke's page-thread time goes (traced, 240 Hz, ms):`, "", "| Stage | Base | Head | Change |", "|---|---:|---:|---:|");
      for (const r of e.head.rows) {
        const b = e.base?.rows.find((x) => x.stage === r.stage)?.ms;
        L.push(`| ${r.stage} | ${fmt(b)} | ${fmt(r.ms)} | ${change(b, r.ms)} |`);
      }
      L.push(`| **page main thread (traced)** | ${fmt(e.base?.mainThreadMs)} | ${fmt(e.head.mainThreadMs)} | ${change(e.base?.mainThreadMs, e.head.mainThreadMs)} |`);
      L.push("", `Dominant stage: **${e.head.dominant.stage}** (${fmt(e.head.dominant.ms)} ms). Off the page thread: stage worker ${fmt(e.head.offMain.stageWorker, 0)} ms, renderer compositor ${fmt(e.head.offMain.rendererCompositor, 0)} ms, display compositor ${fmt(e.head.offMain.displayCompositor, 0)} ms. Profile: \`${e.head.cpuprofile}\`, trace: \`${e.head.trace}\`.`);
    }
    if (results.perf.stored) {
      const s = results.perf.stored;
      L.push("", `Stored baseline: recorded at ${s.commit.slice(0, 9)} on ${s.recorded.slice(0, 10)}; same machine type: ${s.sameMachine ? "yes" : "no"}; same app as the base: ${s.sameApp ? "yes" : "no"}.${s.drift.length ? ` Drift: ${s.drift.join("; ")}.` : ""}`);
    }
    L.push("");
  }
  L.push("## Timings", "", Object.entries(results.timings).map(([k, s]) => `${k} ${s} s`).join(" · "), "");
  L.push(`Logs: \`${rel(LOGS)}\` · every run's numbers: \`${rel(path.join(OUT, "results.json"))}\``);
  fs.writeFileSync(path.join(OUT, "report.md"), L.join("\n") + "\n");
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 1));
  return { failed, status };
}

/* ---------------- baselines ---------------- */

function updateBaselines() {
  // the head's app must be its commit's, so that the stamp means something
  const local = [...new Set([
    ...git(["diff", "--name-only", "HEAD"], ROOT).split("\n"),
    ...git(["ls-files", "--others", "--exclude-standard"], ROOT).split("\n"),
  ].filter(Boolean))];
  const app = classify(local.filter((f) => !f.startsWith("scripts/qa/")), { mergeBase: head.sha, root: ROOT });
  if (TIERS.indexOf(app.tier) >= TIERS.indexOf("pixels")) {
    say(`baselines NOT updated: the working tree has uncommitted app changes (${app.files.filter((f) => f.tier !== "none" && f.tier !== "fast").map((f) => f.file).join(", ")}); commit them first`);
    return false;
  }
  const stamp = { recorded: new Date().toISOString(), commit: head.sha, env };
  fs.mkdirSync(BASELINES, { recursive: true });
  // timings to 0.1 ms; brush:check values exactly (they are deterministic)
  const round = (k, v) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 10) / 10 : v);
  const write = (name, data, replacer = null) => fs.writeFileSync(path.join(BASELINES, name), JSON.stringify({ ...stamp, ...data }, replacer, 1) + "\n");
  write("pixels.json", { paths: Object.fromEntries(paths.map((p) => [p, hashes(path.join(OUT, "pixels", "head", p))])) });
  const { bench, latency, stages } = results.perf;
  write("perf.json", {
    bench: Object.fromEntries(Object.entries(bench).map(([k, e]) => [k, { task: e.head.task, during: e.head.during, after: e.head.after, wall: e.head.wall, strokes: e.head.strokes }])),
    latency: Object.fromEntries(Object.entries(latency).map(([k, e]) => [k, { median: e.head.median, p90: e.head.p90, toFrame: e.head.toFrame, toSwap: e.head.toSwap, threads: e.head.threads }])),
    stages: Object.fromEntries(Object.entries(stages).filter(([, e]) => e.head).map(([k, e]) => [k, { rows: e.head.rows, mainThreadMs: e.head.mainThreadMs, dominant: e.head.dominant, offMain: e.head.offMain }])),
  }, round);
  write("brush-check.json", { checks: results.brushCheck.head.checks });
  say(`baselines recorded in ${rel(BASELINES)} (commit ${head.sha.slice(0, 9)})`);
  return true;
}

/* ---------------- run ---------------- */

try {
  await step("preflight", preflight);
  await step("classify", async () => classifyChange());
  if (tier === "none") say("\nNothing to check: only documentation or recorded baselines changed.");
  if (at("fast")) await step("fast", fast);
  if (at("pixels")) await step("pixels", pixels);
  if (at("perf")) await step("perf", perf);
} catch (e) {
  if (!(e instanceof Stop)) verdict("FAIL", "pipeline", e.message.split("\n")[0]);
  results.error = e.stack;
} finally {
  for (const s of Object.values(servers)) s.stop();
}

const { failed, status } = report();
if (UPDATE) {
  if (failed) say("\nbaselines NOT updated: the run has failures");
  else updateBaselines();
}
// keep the five newest runs in .qa
if (!opt("out", null)) {
  const dir = path.join(ROOT, ".qa");
  const old = fs.readdirSync(dir).filter((d) => /^\d{8}-\d{6}$/.test(d)).sort().slice(0, -5);
  for (const d of old) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
}
say(`\n${status}: ${results.verdicts.filter((x) => x.level === "FAIL").length} failure(s), ${results.verdicts.filter((x) => x.level === "REGRESSION").length} regression(s), ${results.verdicts.filter((x) => x.level === "WARN").length} warning(s) in ${((Date.now() - started) / 60000).toFixed(1)} min`);
say(`report: ${rel(path.join(OUT, "report.md"))}`);
process.exitCode = failed ? 1 : 0;
