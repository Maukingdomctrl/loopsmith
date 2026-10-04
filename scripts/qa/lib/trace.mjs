// Reading a Chrome trace (and a V8 CPU profile) of one stroke: pen-to-screen
// latency, busy time per thread (page, stage worker, compositors), the page
// thread's activities, and the per-stage breakdown of where a stroke's
// main-thread time goes.
import fs from "node:fs";
import { median, quantile } from "./stats.mjs";

export const loadTrace = (file) => {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(raw) ? raw : raw.traceEvents;
};

/** Thread names, the page's renderer, and the stroke window (pointerdown →
 *  last pointerup) in trace microseconds. */
export function traceIndex(ev) {
  const threads = new Map();
  for (const e of ev) if (e.ph === "M" && e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, e.args.name);
  const th = (e) => threads.get(`${e.pid}:${e.tid}`) ?? "";
  const pointer = (type) => ev.filter((e) => e.ph === "X" && e.name === "EventDispatch" && e.args?.data?.type === type && th(e) === "CrRendererMain");
  const downs = pointer("pointerdown"), ups = pointer("pointerup");
  const pid = downs[0]?.pid;
  const down = downs.length ? Math.min(...downs.map((e) => e.ts)) : -Infinity;
  const up = ups.length ? Math.max(...ups.map((e) => e.ts)) : Infinity;
  let end = -Infinity;
  for (const e of ev) if (e.ts > 0 && (e.ph === "X" || e.ph === "E")) end = Math.max(end, e.ts + (e.dur ?? 0));
  return { threads, th, pid, down, up, end };
}

const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN);

/** First item at or after `t` in a list sorted by `key`. */
function after(list, t, key = (x) => x) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (key(list[m]) < t) lo = m + 1; else hi = m; }
  return list[lo];
}

/**
 * Pen movement → on screen. For each pointermove handled on the page: the
 * frame that carries its drawing to the display compositor (the stage
 * worker's, or the page's own after its next animation frame and commit),
 * then the display compositor's next draw-and-swap.
 */
export function penToScreen(ev) {
  const { th, pid } = traceIndex(ev);
  const X = (pred) => ev.filter((e) => e.ph === "X" && pred(e)).sort((a, b) => a.ts - b.ts);
  const moves = X((e) => e.pid === pid && th(e) === "CrRendererMain" && e.name === "EventDispatch" && e.args?.data?.type === "pointermove");
  const rafs = X((e) => e.pid === pid && th(e) === "CrRendererMain" && e.name === "FireAnimationFrame");
  const handled = X((e) => e.pid === pid && /DedicatedWorker/.test(th(e)) && e.name === "HandlePostMessage");
  const pushed = X((e) => e.pid === pid && /DedicatedWorker/.test(th(e)) && e.name === "CanvasResourceDispatcher::DispatchFrame");
  const swaps = X((e) => th(e) === "VizCompositorThread" && e.name === "Display::DrawAndSwap");
  const ends = (name) => ev.filter((e) => e.pid === pid && th(e) === "Compositor" && e.name === name && e.ph === "e").map((e) => e.ts).sort((a, b) => a - b);
  const commits = ends("Commit"), submits = ends("EndActivateToSubmitCompositorFrame");
  const worker = pushed.length > 0;
  const lat = [], toFrame = [];
  for (const mv of moves) {
    let ready;
    if (worker) {
      const draw = after(handled, mv.ts, (d) => d.ts);
      const p = draw && after(pushed, draw.ts + draw.dur, (x) => x.ts);
      if (!p) continue;
      ready = p.ts + p.dur;
    } else {
      const raf = after(rafs, mv.ts + mv.dur, (r) => r.ts);
      const c = raf && after(commits, raf.ts + raf.dur);
      ready = c !== undefined ? after(submits, c) : undefined;
      if (ready === undefined) continue;
    }
    const sw = after(swaps, ready, (s) => s.ts);
    if (!sw) continue;
    lat.push((sw.ts + sw.dur - mv.ts) / 1000);
    toFrame.push((ready - mv.ts) / 1000);
  }
  return {
    stage: worker ? "worker" : "page",
    events: lat.length,
    median: median(lat),
    p90: quantile(lat, 0.9),
    p99: quantile(lat, 0.99),
    // the mean, split in its two legs: until the frame carrying the drawing
    // is handed to the display compositor, then until it is drawn and swapped
    mean: mean(lat),
    toFrame: mean(toFrame),
    toSwap: mean(lat) - mean(toFrame),
  };
}

/** Busy time of one thread's events: the union of its top-level tasks. */
function busy(list, from, to) {
  const top = list
    .filter((e) => e.dur > 0 && e.ts + e.dur > from && e.ts < to &&
      (e.cat?.includes("toplevel") || e.name === "ThreadControllerImpl::RunTask" || e.name === "RunTask" || e.name === "ThreadPool_RunTask"))
    .map((e) => [Math.max(from, e.ts), Math.min(to, e.ts + e.dur)])
    .sort((a, b) => a[0] - b[0]);
  let total = 0, cur = null;
  for (const iv of top) {
    if (!cur || iv[0] > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [...iv]; }
    else cur[1] = Math.max(cur[1], iv[1]);
  }
  if (cur) total += cur[1] - cur[0];
  return total / 1000;
}

/** Complete events (X, and B/E pairs) per thread. */
function eventsByThread(ev) {
  const by = new Map(), open = new Map();
  const push = (k, e) => (by.get(k) ?? by.set(k, []).get(k)).push(e);
  for (const e of ev) {
    const k = `${e.pid}:${e.tid}`;
    if (e.ph === "X") push(k, { name: e.name, cat: e.cat, ts: e.ts, dur: e.dur ?? 0, args: e.args, pid: e.pid });
    else if (e.ph === "B") (open.get(k) ?? open.set(k, []).get(k)).push(e);
    else if (e.ph === "E") {
      const b = open.get(k)?.pop();
      if (b) push(k, { name: b.name, cat: b.cat, ts: b.ts, dur: e.ts - b.ts, args: { ...b.args, ...e.args }, pid: e.pid });
    }
  }
  return by;
}

/** Busy milliseconds per named thread, pointerdown → pointerup and after. */
export function threadBusy(ev) {
  const { threads, pid, down, up, end } = traceIndex(ev);
  const from = down - 2000;
  const rows = [];
  for (const [k, list] of eventsByThread(ev)) {
    const name = threads.get(k) ?? k;
    const total = busy(list, from, end);
    if (total < 0.5) continue;
    rows.push({ thread: name, page: Number(k.split(":")[0]) === pid, total, duringStroke: busy(list, from, up), afterUp: busy(list, up, end) });
  }
  rows.sort((a, b) => b.total - a.total);
  // The ones the reports follow, summed per kind.
  const sum = (pred) => rows.filter(pred).reduce((s, r) => s + r.duringStroke, 0);
  const keyThreads = {
    page: sum((r) => r.page && r.thread === "CrRendererMain"),
    stageWorker: sum((r) => r.page && /DedicatedWorker/.test(r.thread)),
    rendererCompositor: sum((r) => r.page && r.thread === "Compositor"),
    rasterWorkers: sum((r) => r.page && /ThreadPoolForegroundWorker|CompositorTileWorker/.test(r.thread)),
    displayCompositor: sum((r) => r.thread === "VizCompositorThread"),
  };
  return { rows, keyThreads };
}

/** The page thread's self time per activity (EventDispatch by type,
 *  FunctionCall by function, everything else by event name). */
export function mainActivities(ev, { window = "all" } = {}) {
  const { threads, pid, down, up, end } = traceIndex(ev);
  const key = [...threads.keys()].find((k) => Number(k.split(":")[0]) === pid && threads.get(k) === "CrRendererMain");
  const list = (eventsByThread(ev).get(key) ?? []);
  const [from, to] = window === "after" ? [up, end] : window === "stroke" ? [down, up] : [down - 2000, end];
  const label = (e) => e.name === "EventDispatch" ? `EventDispatch(${e.args?.data?.type})`
    : e.name === "FunctionCall" ? `FunctionCall(${e.args?.data?.functionName || "?"})` : e.name;
  const evs = list.filter((e) => e.ts >= from && e.ts < to && e.dur > 0).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const self = new Map(), incl = new Map(), count = new Map();
  const stack = [], nodes = [];
  for (const e of evs) {
    while (stack.length && stack[stack.length - 1].end <= e.ts) stack.pop();
    const k = label(e);
    if (stack.length) stack[stack.length - 1].child += e.dur;
    const node = { k, dur: e.dur, end: e.ts + e.dur, child: 0 };
    stack.push(node);
    nodes.push(node);
    incl.set(k, (incl.get(k) ?? 0) + e.dur);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  for (const n of nodes) self.set(n.k, (self.get(n.k) ?? 0) + Math.max(0, n.dur - n.child));
  return [...self].map(([k, v]) => ({ activity: k, selfMs: v / 1000, inclMs: incl.get(k) / 1000, count: count.get(k) }))
    .sort((a, b) => b.selfMs - a.selfMs);
}

/**
 * Where one stroke's page-thread time goes, by stage: JS stages from the CPU
 * profile (inclusive time by function name, so the build must keep names:
 * `next build --no-mangling`), browser stages from the trace (self time of
 * Blink's own events). `upMs`: pen-up, in ms after the profile started.
 */
export function stageBreakdown(prof, upMs, ev) {
  // JS, from the sampling profile (stroke window: start → pen-up)
  const nodes = new Map(prof.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const incl = new Map();
  let clock = 0;
  const UP = upMs * 1000;
  for (let i = 0; i < prof.samples.length; i++) {
    clock += prof.timeDeltas[i] ?? 0;
    if (clock > UP) break;
    const dt = prof.timeDeltas[i + 1] ?? 0;
    const seen = new Set();
    for (let cur = prof.samples[i]; cur !== undefined; cur = parent.get(cur)) {
      const nm = nodes.get(cur).callFrame.functionName;
      if (nm && !seen.has(nm)) { seen.add(nm); incl.set(nm, (incl.get(nm) ?? 0) + dt); }
    }
  }
  const js = (n) => (incl.get(n) ?? 0) / 1000;

  // Browser, from the trace (the page thread's self times)
  const { th, pid, down, up } = traceIndex(ev);
  const main = ev.filter((e) => e.ph === "X" && e.pid === pid && th(e) === "CrRendererMain").sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  const self = new Map();
  const stack = [];
  const close = (n) => self.set(n.name, (self.get(n.name) ?? 0) + n.dur - n.child);
  for (const e of main) {
    if (e.ts < down || e.ts >= up) continue;
    while (stack.length && stack[stack.length - 1].end <= e.ts) close(stack.pop());
    if (stack.length) stack[stack.length - 1].child += e.dur;
    stack.push({ name: e.name, dur: e.dur, end: e.ts + e.dur, child: 0 });
  }
  while (stack.length) close(stack.pop());
  const nat = (...names) => names.reduce((s, n) => s + (self.get(n) ?? 0), 0) / 1000;
  const mainBusy = main.filter((e) => e.name === "ThreadControllerImpl::RunTask" && e.ts >= down && e.ts < up).reduce((s, e) => s + e.dur, 0) / 1000;
  const frames = main.filter((e) => e.name === "ProxyMain::BeginMainFrame" && e.ts >= down && e.ts < up).length;
  const threadSum = (pred) => ev.filter((e) => e.ph === "X" && e.pid === pid && pred(th(e)) && e.name === "ThreadControllerImpl::RunTask" && e.ts >= down && e.ts < up).reduce((s, e) => s + e.dur, 0) / 1000;

  const rows = [
    ["Input: Blink routing + hit-testing", nat("EventHandler::handleMouseMoveEvent", "HitTest", "LayoutView::HitTest", "EventDispatch", "WebFrameWidgetImpl::HandleInputEvent", "EventHandler::BestNodeForHitTestResult", "LatencyInfo.Flow", "WidgetBaseInputHandler::OnHandleInputEvent")],
    ["Input: React event dispatch (excl. the work below)", js("dispatchContinuousEvent") - js("addSample") - js("screenToCanvas") - js("pointSample") - js("preview")],
    ["Stroke model (path, resampling, dynamics)", js("addSample") - js("dab")],
    ["Rasterization (brush model)", js("dab")],
    ["Dirty-region conversion (float recomposite + 8-bit)", js("previewInto") + js("toImageData")],
    ["Stage hand-off (frame by key + postMessage)", js("send")],
    ["Canvas upload (putImageData + canvas hand-off)", js("putImageData") + nat("CanvasResourceProviderSharedImage::ProduceCanvasResource", "CanvasResourceProvider::WritePixels", "CanvasResourceProviderSharedImage::WritePixels")],
    ["Compositing on the page (drawFrameLayers + raster flush)", js("drawFrameLayers") + nat("CanvasRenderingContext2D::FinalizeFrame")],
    ["React re-render", js("performWorkUntilDeadline")],
    ["Page lifecycle (style, layout, prepaint, paint, layerize)", nat("Document::recalcStyle", "UpdateLayoutTree", "Document::updateStyle", "LocalFrameView::performLayout", "Layout", "Blink.PrePaint.UpdateTime", "PrePaint", "Paint", "Blink.Paint.UpdateTime", "PaintArtifactCompositor::Update", "Layerize", "Blink.CompositingInputs.UpdateTime", "CullRectUpdate", "UpdateLayer")],
    ["Commit to the compositor thread", nat("Commit", "LayerTreeHost::WaitForCommitCompletion", "ProxyMain::BeginMainFrame::commit", "LayerTreeHost::DoUpdateLayers")],
    ["Garbage collection", [...self].filter(([k]) => /GC|gc/.test(k)).reduce((s, [, v]) => s + v, 0) / 1000],
  ].map(([stage, ms]) => ({ stage, ms: Math.max(0, ms) }));
  const sum = rows.reduce((s, r) => s + r.ms, 0);
  rows.push({ stage: "Scheduler, frame overhead, other", ms: Math.max(0, mainBusy - sum) });
  return {
    frames,
    rows,
    mainThreadMs: mainBusy,
    offMain: {
      stageWorker: threadSum((t) => /DedicatedWorker/.test(t)),
      rendererCompositor: threadSum((t) => t === "Compositor"),
      rasterWorkers: threadSum((t) => /ThreadPoolForegroundWorker/.test(t)),
      displayCompositor: ev.filter((e) => e.ph === "X" && th(e) === "VizCompositorThread" && e.name === "ThreadControllerImpl::RunTask" && e.ts >= down && e.ts < up).reduce((s, e) => s + e.dur, 0) / 1000,
    },
    // The dominant bottleneck: the largest named stage on the page thread.
    dominant: rows.filter((r) => !r.stage.startsWith("Scheduler")).sort((a, b) => b.ms - a.ms)[0],
  };
}
