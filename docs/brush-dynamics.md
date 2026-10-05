# Adaptive input and brush dynamics

How a pen sample becomes a dab, for every device and every brush. The work is
split into two layers. The **input layer** (`src/lib/input/`) owns everything
that depends on the device. The **brush dynamics** (`src/lib/raster/brushes/dynamics.ts`)
owns everything that depends on the brush. The materials and the rasterizer
(`models/`, the stroke path, the stage worker) were not rebuilt. They take a
resolved dab and never see a device.

```
PointerEvent (+ coalesced samples)
  │  input layer — src/lib/input/                      device-specific, isolated here
  ├─ 1 read        adapter.ts      every channel, once; position through the canvas mapping
  ├─ 2 time        adapter.ts      timestamps made strictly increasing (TimeRepair)
  ├─ 3 evidence    capabilities.ts what the device reports → DeviceProfile (judged at pen-up)
  ├─ 4 pressure    pipeline.ts     real or not, decided once at pen-down (profile frozen)
  ├─ 5 calibrate   calibration.ts  floor knee / response curve; identity unless evidence
  │                                + the stroke model's averaging width for this device
  ▼
StrokeSample → StrokePath (existing: smoothing, C¹ curve, arc length, zero-lag pressure averaging)
  │  brush dynamics — src/lib/raster/brushes/dynamics.ts   brush-specific, data-driven
  ├─ 1 frame  2 signals  3 pressure  4 pressure responses  5 speed  6 tilt
  ├─ 7 rotation  8 taper  9 jitter  10 limits
  ▼
BrushInput (dab state) → BrushModel (materials) → coverage / density → composite → stage worker
```

The pencil and the rubber (the analytic tools in `src/lib/pencil/`) share
steps 1 to 5. They store the resulting samples as stroke physics. Their own
response (width, density, tooth) stays in the renderer, which runs unchanged
on the page and in the worker.

## The input layer

### 1. Reading (`adapter.ts`)

`readPointer` fills one reused `PenSample` per event, coalesced or not:

| Channel | Read from | Why it matters |
|---|---|---|
| position | the canvas's exact client → layer mapping (once per event batch) | sub-pixel. Positions are bit-identical to the previous code. |
| pressure | `pressure`, as reported | whether it is real, and how fine, is decided from evidence, not here |
| tilt, lean direction | `altitudeAngle` / `azimuthAngle` when present, else `tiltX` / `tiltY` | the spec makes `tiltX` / `tiltY` whole degrees. The angles are doubles (Safari / Apple Pencil). |
| lean direction | carried into layer space (view and layer rotation undone) | the brush path used screen space before: a tilted soft brush leaned the wrong way on a rotated view |
| twist, contact size, tangential pressure | when reported | evidence, and available to dynamics |
| time | `timeStamp`, made strictly increasing | some platforms give every coalesced sample of a frame one timestamp. A batch that does not advance is spread evenly over its interval. Increasing timestamps pass through unchanged. |

A pen held upright has no lean direction: the brush receives azimuth 0
exactly, as before.

### 2. Evidence (`capabilities.ts`)

A `CapabilityTracker` per kind of pointer (pen, touch, mouse) keeps rolling,
fixed-size buffers over the last 24 strokes. It re-judges the device once per
stroke, when the pen lifts, never on a pointer move. Nothing looks at brand
names. A Wacom pen delivers 1024 levels through Windows Ink and more through
other drivers, so only what arrives counts.

| Verdict | Evidence required |
|---|---|
| pressure real / none | real once it varies within a stroke; none after 2+ strokes of only 0, 0.5 or 1 (the spec's stand-ins) |
| quantization step (1/N) | ≥ 24 distinct values all within 2 % of a level of one lattice N ≤ 16384. A continuous pen fails this by ~1e-40. |
| noise σ | rate ≥ 100 Hz, ≥ 256 second differences, successive changes reversing ≥ 45 % of the time (noise reverses ~⅔, a hand almost never), σ ≥ 0.0015 after the quantization share is removed |
| floor | ≥ 8 strokes never below one value ≥ 0.02, with ≥ 60 % of touch-downs and lift-offs bunched just above it |
| ceiling (clip) | ≥ 8 strokes, no stroke above one value < 0.98, ≥ 3 strokes (and ≥ 15 %) holding exactly that value, and that value ≥ 3× as common as all values just below it |
| tilt, twist, contact, sub-pixel | seen at all (tilt > 0.6°, twist ≠ 0, contact > 1.5 px, fractional client px) |
| report rate, time resolution | median sample interval; smallest timestamp step |

Every verdict is deliberately conservative. A false "weak device" verdict
would reshape a good pen. A missed one leaves a weak pen exactly as it was
before this change. An unknown device is trusted completely. The profile is
**frozen when a stroke begins**, so one stroke is processed one way from start
to end. The same input after the same history gives the same pixels.
Profiles live for the session, in memory.

The `tier` (premium / standard / basic / none) is a diagnostic summary.
Nothing branches on it: each compensation is keyed to its own measured
property.

### 3. What is compensated, and the evidence for each choice

Every compensation below was measured on the simulated device classes of
brush:check §13 and §15. Two first designs were measured, found harmful, and
replaced. The numbers are kept here because they explain the final design.

**Premium pens: nothing.** A continuous, clean pen's samples pass through bit
for bit. Pens on fine lattices (1024 levels through Windows Ink, 4096 on
Android) do too. brush:check §13 asserts that the pressures are unchanged and
that the pixels match the previous input path exactly. The QA pixel suite,
driven by a continuous pen, is byte-identical to `main`.

**Coarse lattices (< ~600 levels) and noisy pressure: zero-lag, edge-preserving
averaging in the stroke model.** The stroke model already holds one sample
back to build its curve, and already averages each knot's pressure with its
two neighbours by a Gaussian in time (σ 3 ms). That is symmetric, so it adds
no lag. For an uncertain device the input layer widens it to the device's
report interval, but only across differences that the device's measured
uncertainty √(σ² + Δ²/12) explains (a sigma filter, 4σ). Both neighbours get
the same range weight, so a ramp passes unchanged. The range gates only the
*extra* averaging: a real fast change gets exactly the smoothing it always
had.

| Simulated device, measure | as reported | with averaging |
|---|---|---|
| 256 levels at 100 Hz, Hard Linework r 24: terraces on a slow swell | 0.395 % | 0.294 % |
| same, Soft Round r 30 | 0.043 % | 0.027 % |
| XP-Pen-class (σ 0.004, 1024 levels, 133 Hz): width noise, Hard Linework r 12 | 0.765 % | 0.562 % |
| curve length held back after any sample (latency) | — | 0 px |
| ink beyond the firmer report at a sudden press (overshoot) | — | 0.009 % |
| fast 60 ms flick, older-tablet class, ink vs the hand's intent | 200.9 | 193.9 (no change from averaging) |

What was tried first, and why it was dropped:

- *Interval-constrained reconstruction* held the estimate inside each report's
  quantization interval and extrapolated ramps between level crossings. It is
  ideal for a perfectly monotone ramp (128 levels at 240 Hz: terraces
  0.645 → 0.230 %). With a hand's real tremor (±0.4 % at ~9.5 Hz) it made
  terraces worse in most coarse cases (128 levels at 120 Hz: 0.67 → 1.25 %;
  256 at 240 Hz: 0.21 → 0.46 %). It was removed.
- *Causal noise filters* (that tracker widened to the noise, and an α-β
  filter with Kalman gains) both lag. On the XP-Pen class the RMS error
  against the true pressure was higher than raw on fast and rapid strokes
  (raw 3.3–3.5, filters 6.7–10.0 ×10⁻³). Anything causal trades noise for
  latency. The symmetric averaging above does not.
- *Averaging that ignored the size of a change* (time-only widening, and a
  first sigma filter that gated the whole weight) attenuated fast pressure
  changes. 24, then 2, simulated strokes came out less faithful than raw
  input, until the range weight was made symmetric and limited to the extra
  averaging.

**Floor: a knee at the bottom only.** A device that never reports below F in
contact cannot reach a brush's lightest mark: its lightest touch draws an F
line. A monotone Hermite knee maps F to 0 and rejoins the identity, slope 1,
at F + max(0.08, F). Everything above stays exactly as reported. Stretching
the whole range instead would make every medium stroke lighter on a device
that only clamps its lowest readings.

**Ceiling: detected, not applied.** Mapping a clip to full pressure (a knee at
the top) made firm strokes heavier than intended across the top ~10 % of the
range: older-tablet "taper" ink against intent went 3.4 % → 13.2 %. Whatever
lies above a clip is lost either way. The ceiling stays in the profile, and
`calibrate` supports it for an explicit calibration (`PressureCalibration`),
but evidence alone never applies it.

**Activation force.** A pen that needs, say, 8 % of full force before it
registers reports nothing below that. This happens in force space, before
the browser sees anything, so it is invisible to the engine and nothing can
draw it back. The fix would be a response curve the user sets by drawing (not built).

**Devices without pressure.** Mice, and pens or fingers that only report
0.5, get each brush's `mouse` stand-in (speed and arc-length dynamics), or
the pencil's fixed medium touch, exactly as before. A touch stylus counts as
having pressure when its first report is a real reading. That is now decided
once per stroke rather than per sample, so a reading that happens to equal
0.5 can no longer spike a stroke.

## Brush dynamics (`src/lib/raster/brushes/dynamics.ts`)

One `DynamicsEvaluator` turns every point of the curve into the dab a material
draws. What differs between brushes is data: the preset's `BrushDynamics`
and its `MouseDynamics` stand-in.

| # | Stage | What, and why here |
|---|---|---|
| 1 | frame | time since pen-down, arc length, travel and time since the last dab, length left (known at pen-up) |
| 2 | signals | speed on screen (canvas px/ms), tilt 0..1, lean direction: derived once, read by every later stage |
| 3 | pressure | the device's, through the brush's pressure curve; or, without pressure, the stand-in, which is built from speed and arc length (so it needs 1 and 2) |
| 4 | pressure responses | texture, hardness, on top of the material's own pressure physics |
| 5 | speed | size, opacity, flow, spacing factors |
| 6 | tilt | size, opacity, flow, texture factors |
| 7 | rotation | user angle + barrel twist (+ stroke direction or lean when the preset follows one) |
| 8 | taper | start and end envelopes. They come after the responses, so a taper reaches its end value whatever the hand does there. |
| 9 | jitter | size, opacity, angle, scatter. It comes after the taper, so a taper to zero stays zero. It is a smooth function of arc length and the stroke's seed: deterministic and input-rate independent (60 vs 500 Hz: 0.27 %). |
| 10 | limits | sizes and amounts non-negative, hardness 0..1 |

Stages 4 to 9 multiply. A response a preset does not define is not computed
at all. A preset without dynamics therefore resolves to *exactly* the dab it
always did. brush:check §14 asserts zero pixels changed for every brush and
material, and the original §1 to §10 precision values are bit-identical.
Every response is a continuous, monotone curve (`curves.ts`). The measured
tests are: no reversals or flat steps over 10 000 pressure steps; largest
size change 0.005 px per 0.005 px/ms of speed; rotation following the
direction to 0 rad error.

**Pressure → size, opacity and flow is each material's physics** (a pen's
swelling line, an airbrush's deposit, a wash's water) and stays in `models/`.
The preset shapes the pressure that reaches it (`dynamics.pressure`) and adds
what the hand does besides pressing. Each model applies what its physics has
a place for:

| Model | size | opacity | flow | spacing | hardness | texture |
|---|---|---|---|---|---|---|
| hard (Hard Linework) | ✓ | ✓ | — exact geometry | — polyline only | — always hard | — grain is per material |
| soft (Soft Round / Rectangle, Marker, Eraser) | ✓ | ✓ | ✓ | ✓ | ✓ plateau / perimeter | — |
| texture | ✓ | ✓ | ✓ | ✓ | — | ✓ streaks and tooth |
| water | ✓ | ✓ pigment | ✓ water + pigment | — part of the simulation | — | — paper's |

Known limit: an end taper can only shape what is not drawn yet when the pen
lifts, which is the last span. This is the same limit the mouse stand-in's
taper has always had. Dabs already laid are never revised.

## Presets (`presets.ts`): one engine, data per brush

| Representative brush | In Loopsmith |
|---|---|
| hard brush | Hard Linework → Technical pen |
| ink | Hard Linework → Ink brush |
| pencil | the Pencil tool (analytic graphite); Hard Linework → Sharp pencil; Texture → Graphite |
| airbrush | Soft Round |
| watercolor | Water |
| texture brush | Texture (graphite, charcoal, canvas, paper, dry brush) |
| **marker** (new) | **Marker**: the soft model, a chisel footprint, `dynamics` only: early pressure response, firm edge, runs dry when flicked |
| **eraser** (new) | **Eraser** brush: the soft model compositing destination-out, `dynamics` only; on a mask it paints the hiding grey, like the rubber. The Eraser tool (the analytic rubber) is unchanged. |

A new brush is a `BrushSpec` entry. The Marker and the Eraser needed no model
code. The Eraser only needed the stroke's erase composite, which is one
branch in `MaterialStroke`.

## Premium-input fixes along the way

- The brush path now uses the double-precision `altitudeAngle` /
  `azimuthAngle` where available, and carries the lean direction into layer
  space.
- `StrokePath` interpolates lean direction and barrel twist the short way
  round. A pen leaning across ±180°, or a twist crossing 0°/360°, used to
  swing through the opposite direction between two samples.
- The pencil path reads the layout once per event, not once per coalesced
  sample.

## Performance

Measured, not assumed:

| Cost | Value | Where |
|---|---|---|
| input layer, per sample | 0.09 – 0.35 µs (continuous or coarse floored pen, across runs) | brush:check §11 |
| dynamics, per dab | 0.12 – 0.51 µs (no responses … every response on) | brush:check §11 |
| stroke model + material + preview, per sample | unchanged: −2.6 % … +2.9 % in 9 cases | interleaved A/B with `main`, best of 21 runs |

Target: under 50 µs per sample (0.05 ms). The new layers cost about
1/1000 of the stroke model and material, so they are not where time goes.
The measured bottleneck that did involve pressure was elsewhere: the pencil
cursor's tip followed pen pressure through React state, re-rendering the
editor on frames where the pressure changed (75–78 ms per stroke in the
stage breakdown). The tip is now resized in place
(`BrushCursor.sizeCursorTip`), as its position already was, in the same 5 %
steps. Finer steps repaint the cursor on nearly every frame of a slow stroke
and cost more than they saved: 1 % steps made the pencil 8 % slower at one
event per frame.

End to end (`npm run qa`, `main` → this change, medians of warm 241-event
strokes): the pencil's main thread is 10–11 % lighter (412 → 365 ms at one
event per frame, 225 → 203 ms at 240 Hz), the brushes are unchanged within
the run-to-run spread (−6 % … +5 %, none near the 12 % limit), and
pen-to-screen latency is unchanged (Hard Linework median 14.8 → 13.6 ms,
pencil 19.4 → 19.6 ms). The full tables are in the pull request.

## QA

- `npm run brush:check` §11 to §15 (`scripts/brush-check/dynamics.ts`) runs on
  **simulated** device classes (`scripts/brush-check/devices.ts`, every name
  `sim:…`):

  | Simulated class | What it reports |
  |---|---|
  | Apple Pencil-class | continuous, 240 Hz, tilt as angles |
  | S Pen-class | 4096 levels |
  | Wacom through Windows Ink | 1024 levels, 200 Hz, whole-degree tilt, twist |
  | XP-Pen Star 03-class | 1024 levels, 133 Hz, σ 0.004, 8 % activation force |
  | older tablet | 256 levels, 100 Hz, floor 0.12, clips at 0.9, 1 ms timestamps |
  | touch stylus without pressure | — |
  | mouse | — |

  Each class has a realistic hand tremor. The matrix is 7 devices × 8
  gestures × 60/120/240/500 Hz × a 0.6 px and a 22 px brush. These are
  assumptions about classes of hardware, not measurements of it.
- The scenario suite has a `presets` session (Marker over a wash, then the
  Eraser brush). A build without those brushes skips it. The QA pipeline
  reports captures only the head can make as INFO ("record the baselines
  after the merge"). A missing or differing capture still fails.
- `classify.mjs` sends `src/lib/input/` through the full brush-engine plan.

## Known limits

- **Simulation, not hardware.** Every device result in this document comes
  from simulated classes. Nothing has been tried on a physical pen yet (see
  below).
- **Evidence takes strokes.** A device is drawn exactly as reported until
  there is enough evidence. A lattice needs 24 distinct values. Noise needs
  256 evenly spaced samples at 100 Hz or more. A floor needs 8 strokes. A weak
  pen's first strokes in a session look as they did before this change.
- **One tracker per kind of pointer.** Pointer Events do not say which
  physical pen is in use, so two pens used in one session share their
  evidence. Mixing errs toward leaving input as reported: a floor or a lattice
  must hold for every stroke and value in the 24-stroke window, so one stroke
  from a cleaner pen clears it. After a switch the window re-learns.
- **Activation force** cannot be recovered, and **a clipped ceiling** is
  detected but not applied (both above).
- **The pencil** gets every channel and the floor calibration, but not the
  stroke model's pressure averaging. Its strokes are stored as samples and
  drawn analytically, and that renderer is unchanged.
- **An end taper** shapes only the last span (above).

## Validating on real hardware

No physical pen was available where this was built. Nothing here claims
device-specific support from simulation. On each real device (Apple Pencil,
S Pen, XP-Pen Star 03, a Wacom, a generic stylus), check:

1. **What the engine detects.** In a development build (`npm run dev`), draw
   about 10 ordinary strokes (light and firm, slow and fast), then run
   `loopsmithInput()` in the browser console. It lists the profile judged
   for each kind of pointer so far (`src/lib/input/capabilities.ts`). Compare
   it with the device's known path. For example, a Wacom through Windows Ink
   should show `pressureStep` 0.000977 (1/1024) and `floor` 0. An Apple
   Pencil should show continuous pressure (`pressureStep` 0) and `tilt`.
2. **Range.** The lightest touch reaches a hairline (Hard Linework) or a
   faint haze (Soft Round), and the firmest reaches full size.
3. **Smoothness.** On a very slow swell with a large Hard Linework (r 24),
   look for width terraces, and on a steady stroke for a wobbly edge.
4. **Response.** A quick pressure flick keeps its accent, and the stroke's
   end keeps up with the pen (latency).
5. **Tilt and rotation**, where the device reports them. A tilted Soft Round
   stretches along the lean, on a rotated view too.
6. Compare the same strokes with `main` for any regression in feel.
