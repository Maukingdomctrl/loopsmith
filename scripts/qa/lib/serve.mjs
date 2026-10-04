// Builds and servers for the pipeline. The head is the working tree, built in
// place; a base ref is checked out in a git worktree under the QA cache
// (QA_CACHE, default <tmp>/loopsmith-qa) and built there once per commit.
// Both are production builds that keep function names (`next build
// --no-mangling`): the same compile and type check as `npm run build`, and
// CPU profiles that read in the source's names.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const git = (args, cwd = process.cwd()) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }).trim();

export const repoRoot = () => git(["rev-parse", "--show-toplevel"]);
export const cacheDir = () => process.env.QA_CACHE || path.join(os.tmpdir(), "loopsmith-qa");
const nextBin = (dir) => path.join(dir, "node_modules", "next", "dist", "bin", "next");
const quietEnv = { NEXT_TELEMETRY_DISABLED: "1" };

/** The last lines of a log file. */
export function tail(file, lines = 25) {
  if (!fs.existsSync(file)) return "";
  return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines).join("\n");
}

/** Runs a command with its output appended to `log`; rejects with the log's tail. */
export function run(cmd, args, { cwd, log, env } = {}) {
  return new Promise((resolve, reject) => {
    const fd = log ? fs.openSync(log, "a") : "ignore";
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", fd, fd] });
    p.on("error", reject);
    p.on("exit", (code) => {
      if (log) fs.closeSync(fd);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} ${args.join(" ")} exited with ${code}${log ? `\n${tail(log)}` : ""}`));
    });
  });
}

/** `next build --no-mangling` in `dir`; seconds taken. */
export async function build(dir, { log }) {
  const t0 = Date.now();
  await run(process.execPath, [nextBin(dir), "build", "--no-mangling"], { cwd: dir, log, env: quietEnv });
  return (Date.now() - t0) / 1000;
}

/**
 * node_modules for a worktree: the repo's own, hard-linked (Linux) or cloned
 * (macOS), when the lockfiles match — Turbopack refuses a symlinked
 * node_modules — else a clean `npm ci`.
 */
async function installDeps(root, dir, { log }) {
  const lock = (d) => (fs.existsSync(path.join(d, "package-lock.json")) ? fs.readFileSync(path.join(d, "package-lock.json")) : null);
  const same = lock(root) && lock(dir) && lock(root).equals(lock(dir)) && fs.existsSync(path.join(root, "node_modules"));
  if (same && process.platform === "linux") return run("cp", ["-al", path.join(root, "node_modules"), path.join(dir, "node_modules")], { log });
  if (same && process.platform === "darwin") return run("cp", ["-Rc", path.join(root, "node_modules"), path.join(dir, "node_modules")], { log });
  return run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--no-audit", "--no-fund"], { cwd: dir, log });
}

/** The full commit id of a ref. */
export const resolveRef = (ref, root = repoRoot()) => git(["rev-parse", "--verify", `${ref}^{commit}`], root);

/**
 * A base ref checked out and built in the QA cache. Reused while the commit
 * is the same (the build is stamped when it finishes).
 */
export async function prepareBase(ref, { log }) {
  const root = repoRoot();
  const sha = resolveRef(ref, root);
  const dir = path.join(cacheDir(), "builds", sha.slice(0, 12));
  const stamp = path.join(dir, ".qa-built");
  if (fs.existsSync(stamp) && fs.existsSync(path.join(dir, ".next", "BUILD_ID"))) return { dir, sha, cached: true, seconds: 0 };
  if (fs.existsSync(dir)) {
    try { git(["worktree", "remove", "--force", dir], root); } catch { /* not a worktree any more */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  git(["worktree", "prune"], root);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(["worktree", "add", "--detach", "--force", dir, sha], root);
  const t0 = Date.now();
  await installDeps(root, dir, { log });
  await build(dir, { log });
  fs.writeFileSync(stamp, `${sha}\n`);
  return { dir, sha, cached: false, seconds: (Date.now() - t0) / 1000 };
}

/** A port nothing listens on. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const running = new Set();
const stopAll = () => { for (const stop of running) stop(); };
process.on("exit", stopAll);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopAll(); process.exit(130); });

/**
 * Files `next dev` may write into the project: AGENTS.md / CLAUDE.md when it
 * detects an AI agent (next.config `agentRules`), and its TypeScript set-up.
 * They are put back when the dev server stops, so a run leaves the tree as it
 * found it.
 */
const DEV_WRITES = ["AGENTS.md", "CLAUDE.md", "tsconfig.json", "next-env.d.ts"];

function snapshot(dir, names) {
  return names.map((n) => {
    const f = path.join(dir, n);
    return [f, fs.existsSync(f) ? fs.readFileSync(f) : null];
  });
}
function restore(saved) {
  for (const [f, data] of saved) {
    const now = fs.existsSync(f) ? fs.readFileSync(f) : null;
    if (data === null) { if (now !== null) fs.rmSync(f, { force: true }); }
    else if (!now?.equals(data)) fs.writeFileSync(f, data);
  }
}

/**
 * Serves `dir` with `next start` (a production build) or `next dev`, on a free
 * port; resolves once the page answers. `stop()` ends the server.
 */
export async function serve(dir, { dev = false, log, timeoutMs = dev ? 240000 : 60000 } = {}) {
  const port = await freePort();
  const saved = dev ? snapshot(dir, DEV_WRITES) : null;
  const fd = fs.openSync(log, "a");
  const p = spawn(process.execPath, [nextBin(dir), dev ? "dev" : "start", "-p", String(port)], {
    cwd: dir, env: { ...process.env, ...quietEnv }, stdio: ["ignore", fd, fd], detached: process.platform !== "win32",
  });
  fs.closeSync(fd);
  let exited = null;
  p.on("exit", (code) => {
    exited = code ?? "signal";
    if (saved) restore(saved);
  });
  const stop = () => {
    running.delete(stop);
    if (saved) restore(saved);
    if (exited !== null) return;
    try {
      if (process.platform === "win32") p.kill();
      else process.kill(-p.pid, "SIGTERM");
    } catch { /* gone */ }
  };
  running.add(stop);
  const url = `http://localhost:${port}/`;
  const t0 = Date.now();
  for (;;) {
    if (exited !== null) throw new Error(`next ${dev ? "dev" : "start"} exited (${exited}) in ${dir}\n${tail(log)}`);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(dev ? 120000 : 10000) });
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) { stop(); throw new Error(`no answer from ${url} after ${timeoutMs / 1000} s\n${tail(log)}`); }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { url, port, stop };
}
