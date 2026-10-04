// Lint problems a change adds. The repository has known ESLint problems
// elsewhere, so `npm run lint` alone cannot tell a change's own: this lints
// each changed file and the same file at the merge base (as if it were in
// the working tree, with today's config) and reports the difference.
//
//   node scripts/qa/lint-delta.mjs [--base origin/main]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { options } from "./lib/env.mjs";
import { repoRoot } from "./lib/serve.mjs";
import { changedFiles } from "./classify.mjs";

const LINTABLE = /\.(m?[jt]sx?|cjs)$/;

/** Problems per (severity, rule), with their lines and messages. Counted
 *  per rule, not per message: messages name identifiers, so a renamed
 *  variable would otherwise read as one problem fixed and one added. */
function tally(result) {
  const m = new Map();
  for (const p of result?.messages ?? []) {
    const k = `${p.severity === 2 ? "error" : "warning"}|${p.ruleId ?? "parse"}`;
    (m.get(k) ?? m.set(k, []).get(k)).push({ line: p.line, message: p.message });
  }
  return m;
}

/**
 * For each changed, lintable file: problems that are new (more of a kind
 * than at the merge base) and how many went away.
 */
export async function lintDelta(files, mergeBase, root = repoRoot()) {
  const eslint = new ESLint({ cwd: root });
  const out = { files: 0, newErrors: 0, newWarnings: 0, fixed: 0, problems: [] };
  for (const f of files) {
    const abs = path.join(root, f);
    if (!LINTABLE.test(f) || !fs.existsSync(abs) || (await eslint.isPathIgnored(abs))) continue;
    out.files++;
    const [head] = await eslint.lintFiles([abs]);
    let before = null;
    try {
      const text = execFileSync("git", ["show", `${mergeBase}:${f}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
      [before] = await eslint.lintText(text, { filePath: abs });
    } catch { /* a new file */ }
    const now = tally(head), then = tally(before);
    for (const [k, list] of now) {
      const extra = list.length - (then.get(k)?.length ?? 0);
      if (extra <= 0) continue;
      const [severity, rule] = k.split("|");
      // which of them are new is a guess: the ones whose message is new
      const known = new Set((then.get(k) ?? []).map((p) => p.message));
      const fresh = list.filter((p) => !known.has(p.message));
      const shown = (fresh.length ? fresh : list).slice(0, extra);
      out.problems.push({ file: f, severity, rule, count: extra, lines: shown.map((p) => p.line), message: shown[0].message });
      if (severity === "error") out.newErrors += extra; else out.newWarnings += extra;
    }
    for (const [k, list] of then) out.fixed += Math.max(0, list.length - (now.get(k)?.length ?? 0));
  }
  return out;
}

export function describeLint(d) {
  return `${d.files} changed file(s) linted: ${d.newErrors} new error(s), ${d.newWarnings} new warning(s), ${d.fixed} fixed`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opt = options();
  const base = String(opt("base", "origin/main"));
  const { mergeBase, files } = changedFiles(base);
  const d = await lintDelta(files, mergeBase);
  console.log(describeLint(d));
  for (const p of d.problems) console.log(`  ${p.severity.padEnd(7)} ${p.file}:${p.lines.join(",")}  ${p.rule}: ${p.message}${p.count > 1 ? ` (+${p.count})` : ""}`);
  process.exitCode = d.newErrors ? 1 : 0;
}
