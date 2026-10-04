// Per-stage breakdown of one stroke's page-thread time, and the dominant
// bottleneck: JS stages from a V8 CPU profile, browser stages from a trace,
// both of the same stroke (stroke.mjs --cpuprofile … --trace … --out run.json).
// The build must keep function names: `next build --no-mangling`.
//
//   node scripts/qa/stages.mjs cpu.json run.json trace.json
//   node scripts/qa/stages.mjs cpu.json <pen-up ms after profile start> trace.json
import fs from "node:fs";
import { loadTrace, stageBreakdown } from "./lib/trace.mjs";

const [cpuFile, upArg, traceFile] = process.argv.slice(2);
// pen-up: from stroke.mjs's --out file (the last stroke), or given in ms
let upMs = Number(upArg);
if (Number.isNaN(upMs)) {
  const last = JSON.parse(fs.readFileSync(upArg, "utf8")).results.at(-1).marks;
  upMs = last.upSent - last.start;
}
const r = stageBreakdown(JSON.parse(fs.readFileSync(cpuFile, "utf8")), upMs, loadTrace(traceFile));
console.log(`stroke window (pointerdown → pointerup): ${r.frames} frames`);
for (const row of r.rows) console.log(`  ${row.stage.padEnd(58)} ${row.ms.toFixed(1).padStart(7)} ms`);
console.log(`  ${"= page main thread (traced)".padEnd(58)} ${r.mainThreadMs.toFixed(1).padStart(7)} ms`);
console.log(`  off the page thread: stage worker ${r.offMain.stageWorker.toFixed(0)} ms, renderer compositor ${r.offMain.rendererCompositor.toFixed(0)} ms, raster workers ${r.offMain.rasterWorkers.toFixed(0)} ms, display compositor ${r.offMain.displayCompositor.toFixed(0)} ms`);
console.log(`dominant stage: ${r.dominant.stage} (${r.dominant.ms.toFixed(1)} ms)`);
