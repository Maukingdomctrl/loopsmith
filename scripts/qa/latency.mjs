// Pen movement → on screen, from a trace of a stroke (stroke.mjs --trace).
//
//   node scripts/qa/latency.mjs trace.json [more traces…]
//
// For each pointermove handled on the page: the frame that carries its
// drawing to the display compositor (the stage worker's, or the page's own),
// then the display compositor's next draw-and-swap. Headless numbers include
// Chromium's frame pipeline; compare builds on the same machine.
import { loadTrace, penToScreen } from "./lib/trace.mjs";

for (const file of process.argv.slice(2)) {
  const r = penToScreen(loadTrace(file));
  if (!r.events) { console.log(`${file}: no pen movements matched`); continue; }
  console.log(`${file}: stage drawn by the ${r.stage}, ${r.events} pen movements: median ${r.median.toFixed(1)} ms, p90 ${r.p90.toFixed(1)} ms, p99 ${r.p99.toFixed(1)} ms`);
  console.log(`  mean ${r.mean.toFixed(1)} ms = ${r.toFrame.toFixed(1)} ms until the frame reaches the display compositor + ${r.toSwap.toFixed(1)} ms until it is on screen`);
}
