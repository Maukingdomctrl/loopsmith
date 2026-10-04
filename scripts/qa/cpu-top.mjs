// V8 CPU profile (stroke.mjs --cpuprofile) → self time per function and
// inclusive time per function name. Build with `next build --no-mangling`
// so the names are the source's.
//
//   node scripts/qa/cpu-top.mjs cpu.json [--top 40] [--incl name1,name2] [--from ms] [--to ms]
import fs from "node:fs";

const prof = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const TOP = Number(arg("top") || 40);
const inclNames = arg("incl") ? arg("incl").split(",") : [];

const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

// time per sample, optionally only inside [from, to] ms after the profile start
const FROM = arg("from") !== undefined ? Number(arg("from")) * 1000 : -Infinity;
const TO = arg("to") !== undefined ? Number(arg("to")) * 1000 : Infinity;
const dt = new Map();
let clock = 0;
for (let i = 0; i < prof.samples.length; i++) {
  clock += prof.timeDeltas[i] ?? 0;
  if (clock < FROM || clock > TO) continue;
  const id = prof.samples[i];
  dt.set(id, (dt.get(id) ?? 0) + (prof.timeDeltas[i + 1] ?? prof.timeDeltas[i] ?? 0));
}
const label = (n) => {
  const f = n.callFrame;
  return `${f.functionName || "(anon)"} ${(f.url || "").split("/").pop()}:${f.lineNumber + 1}`;
};
const self = new Map();
let total = 0;
for (const [id, t] of dt) {
  const k = label(nodes.get(id));
  self.set(k, (self.get(k) ?? 0) + t);
  total += t;
}
const idle = [...dt].filter(([id]) => nodes.get(id).callFrame.functionName === "(idle)").reduce((s, [, t]) => s + t, 0);
console.log(`profile span ${(clock / 1000).toFixed(0)} ms: ${(total / 1000).toFixed(1)} ms sampled, idle ${(idle / 1000).toFixed(1)} ms, busy ${((total - idle) / 1000).toFixed(1)} ms`);
console.log(`\n== self time ==`);
for (const [k, v] of [...self].sort((a, b) => b[1] - a[1]).slice(0, TOP)) console.log(`  ${(v / 1000).toFixed(1).padStart(8)} ms  ${k}`);

// inclusive: each sample counts once per distinct function name on its stack
const incl = new Map();
for (const [id, t] of dt) {
  const seen = new Set();
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const nm = nodes.get(cur).callFrame.functionName;
    if (nm && !seen.has(nm)) { seen.add(nm); incl.set(nm, (incl.get(nm) ?? 0) + t); }
  }
}
console.log(`\n== inclusive time ==`);
const want = inclNames.length ? inclNames : [...incl].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([k]) => k);
for (const k of want) console.log(`  ${((incl.get(k) ?? 0) / 1000).toFixed(1).padStart(8)} ms  ${k}`);
