// What triggers a given event on the page thread, from a trace: how many
// times it ran, how long, and under which parent events. The default event
// is the full copy of a 2D canvas to the compositor on each frame it changes
// (the bottleneck the stage worker removed from the page thread).
//
//   node scripts/qa/trace-callers.mjs trace.json [EventName]
import { loadTrace } from "./lib/trace.mjs";

const ev = loadTrace(process.argv[2]);
const target = process.argv[3] || "CanvasResourceProviderSharedImage::ProduceCanvasResource";
const tn = new Map();
for (const e of ev) if (e.ph === "M" && e.name === "thread_name") tn.set(`${e.pid}:${e.tid}`, e.args.name);
const main = ev.filter((e) => tn.get(`${e.pid}:${e.tid}`) === "CrRendererMain" && e.ph === "X");
// the renderer with pointer events
const pids = new Set(main.filter((e) => e.name === "EventDispatch" && /^pointer/.test(e.args?.data?.type ?? "")).map((e) => e.pid));
const m = main.filter((e) => pids.has(e.pid)).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
const chains = new Map();
const stack = [];
const durs = [];
for (const e of m) {
  while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= e.ts) stack.pop();
  if (e.name === target) {
    const chain = stack.map((s) => s.name).filter((n) => !/RunTask|v8\.|ThreadController|Blink|BlinkScheduler/.test(n)).slice(-6).join(" > ");
    chains.set(chain, (chains.get(chain) ?? 0) + 1);
    durs.push(e.dur);
  }
  stack.push(e);
}
if (!durs.length) {
  console.log(`${target}: not on the page thread in this trace`);
} else {
  durs.sort((a, b) => a - b);
  console.log(`${target}: n=${durs.length} median ${(durs[durs.length >> 1] / 1000).toFixed(3)} ms, p95 ${(durs[Math.floor(durs.length * 0.95)] / 1000).toFixed(3)} ms`);
  for (const [c, n] of [...chains].sort((a, b) => b[1] - a[1])) console.log(`  ${n}× ${c}`);
}
