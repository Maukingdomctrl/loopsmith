// Where a stroke's time went, per thread (the page, the stage worker, the
// renderer compositor, raster workers, the display compositor), and the page
// thread's busiest activities — from a trace (stroke.mjs --trace).
//
//   node scripts/qa/threads.mjs trace.json [--top 25] [--window all|stroke|after]
import { loadTrace, mainActivities, penToScreen, threadBusy } from "./lib/trace.mjs";
import { options } from "./lib/env.mjs";

const file = process.argv[2];
const opt = options(process.argv.slice(3));
const TOP = Number(opt("top", 25));
const ev = loadTrace(file);

const { rows, keyThreads } = threadBusy(ev);
console.log(`trace: ${file}`);
console.log(`\n== Busy time per thread (union of top-level tasks) ==`);
for (const r of rows) {
  console.log(`  ${(r.page ? "page" : "other").padEnd(6)} ${r.thread.padEnd(32)} ${r.total.toFixed(1).padStart(8)} ms   (down→up ${r.duringStroke.toFixed(1).padStart(7)}, after up ${r.afterUp.toFixed(1).padStart(7)})`);
}
console.log(`\nkey threads, pen-down → pen-up: ${Object.entries(keyThreads).map(([k, v]) => `${k} ${v.toFixed(1)} ms`).join(", ")}`);

console.log(`\n== Page thread: self time by activity (top ${TOP}, window ${opt("window", "all")}) ==`);
for (const a of mainActivities(ev, { window: String(opt("window", "all")) }).slice(0, TOP)) {
  console.log(`  ${a.activity.padEnd(54)} self ${a.selfMs.toFixed(1).padStart(8)} ms   incl ${a.inclMs.toFixed(1).padStart(8)} ms   n=${a.count}`);
}
const lat = penToScreen(ev);
if (lat.events) console.log(`\npen → screen: median ${lat.median.toFixed(1)} ms, p90 ${lat.p90.toFixed(1)} ms, p99 ${lat.p99.toFixed(1)} ms (${lat.events} moves, stage drawn by the ${lat.stage})`);
