/**
 * Raster subsystem types.
 *
 * COORDINATE CONTRACT — the single most important thing in this module:
 * every coordinate here is in LAYER-LOCAL pixels, i.e. the layer's own source
 * bitmap space. Never canvas space, never screen space.
 *
 * That is not a stylistic choice. A stroke painted in canvas space would
 * change its width when the layer is scaled, would resample when the layer is
 * rotated, and would land in the wrong place the moment the pose changed after
 * the fact. Painting in local space means the stroke IS the bitmap: it is
 * transform-invariant, and the existing compositor draws it through the same
 * layer matrix as everything else.
 *
 * Callers convert once, at the boundary, via `canvasPointToLocal`.
 */

import type { BlendMode } from "@/types/layer";
import type { Rect, Vec2 } from "@/types/geometry";

/* ========== input ========== */

/**
 * One raw pointer sample, already converted to local space.
 *
 * `pressure` is 0..1 as reported by PointerEvent; mice report 0.5 when down
 * and 0 when up, which is why `normalizePressure` in constants.ts exists.
 * `time` is kept because velocity-driven dynamics need it, and because a
 * duplicated sample at the same position but a later time is a legitimate
 * "dwell" that some brushes respond to.
 */
export interface StrokeSample {
  readonly x: number;
  readonly y: number;
  /** 0..1. Already normalized — see normalizePressure. */
  readonly pressure: number;
  /** Radians from the surface normal, 0 = perpendicular. 0 when unsupported. */
  readonly tilt: number;
  /** Stylus barrel rotation in radians, 0 when unsupported. */
  readonly twist: number;
  /** ms, monotonic. */
  readonly time: number;
  /** Direction the stylus leans toward, radians. Only meaningful when `tilt` > 0. */
  readonly azimuth?: number;
}

/** A point on the resampled, arc-length-parameterized stroke path. */
export interface StrokePoint {
  readonly x: number;
  readonly y: number;
  /** Distance along the path from the stroke's origin, in local px. */
  readonly distance: number;
  /** Unit tangent. Drives directional brushes and the arrow head. */
  readonly tangent: Vec2;
  /** Interpolated dynamics at this arc-length position. */
  readonly pressure: number;
  readonly tilt: number;
  readonly twist: number;
  /** Local px per ms at this point. 0 for the first point. */
  readonly speed: number;
  /** ms, interpolated along the path like every other dynamic. */
  readonly time: number;
  /** Direction the stylus leans toward, radians. */
  readonly azimuth: number;
}

/* ========== brush ========== */

export type BrushShape = "round" | "square" | "chisel";

/** How successive stamps accumulate within ONE stroke. */
export type BrushAccumulation =
  /** coverage = max(coverage, stamp). Overlaps never darken; the whole stroke
   *  is composited once at `opacity`. This is what makes a soft brush look
   *  like a single ribbon instead of a chain of beads. */
  | "wet"
  /** coverage += stamp·(1 − coverage). Builds up toward 1 the longer you dwell. */
  | "buildup";

/** Maps a normalized input (pressure, tilt, speed) onto a 0..1 output. */
export interface DynamicCurve {
  /** Output at input 0. */
  readonly min: number;
  /** Output at input 1. */
  readonly max: number;
  /** Gamma. 1 = linear, >1 = late response, <1 = early response. */
  readonly gamma: number;
}

export interface BrushSettings {
  /** Radius in LOCAL px at pressure 1, before dynamics. */
  readonly radius: number;
  /** 0 = maximally soft (Gaussian-like), 1 = hard edge with 1px analytic AA. */
  readonly hardness: number;
  /** Per-stamp alpha. Combined with coverage accumulation. */
  readonly flow: number;
  /** Alpha the finished stroke is composited at. */
  readonly opacity: number;
  /** Stamp interval as a fraction of the CURRENT diameter. 0.05–0.25 typical. */
  readonly spacing: number;
  readonly shape: BrushShape;
  /** Aspect ratio for chisel/square, w/h. 1 = isotropic. */
  readonly aspect: number;
  /** Fixed rotation of the stamp, radians. Ignored when `followTangent`. */
  readonly angle: number;
  /** Rotate the stamp to the path tangent — calligraphic behaviour. */
  readonly followTangent: boolean;
  readonly accumulation: BrushAccumulation;
  readonly blend: BlendMode;

  /** Dynamics. Set `max === min` to disable an axis. */
  readonly sizeByPressure: DynamicCurve;
  readonly flowByPressure: DynamicCurve;
  /** Faster stroke ⇒ thinner. Normalized against SPEED_REFERENCE. */
  readonly sizeBySpeed: DynamicCurve;

  /** Positional jitter, in radius fractions. Seeded — see `seed`. */
  readonly scatter: number;
  /** Per-stamp size jitter, in radius fractions. */
  readonly sizeJitter: number;
  /**
   * PRNG seed. Present so that jitter is DETERMINISTIC: the same stroke
   * replayed must produce the same pixels, or undo/redo and any regression
   * test become meaningless.
   */
  readonly seed: number;

  /** Straight RGBA, 0..1 per channel. Alpha here is a colour property; stroke
   *  alpha comes from flow/opacity/coverage. */
  readonly color: RGBA;

  /** Input smoothing strength, 0..1. Applied before path fitting. */
  readonly smoothing: number;
  /** Catmull-Rom knot exponent. 0.5 = centripetal (no cusps), 0 = uniform. */
  readonly curveAlpha: number;
}

/* ========== colour ========== */

/** Straight (NON-premultiplied) RGBA, each channel 0..1. */
export interface RGBA {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Premultiplied RGBA, 0..1. The surface's internal representation. */
export interface PremultipliedRGBA {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface HSVA {
  /** Degrees, 0..360. */
  readonly h: number;
  readonly s: number;
  readonly v: number;
  readonly a: number;
}

/* ========== shapes ========== */

export type ShapeKind = "rectangle" | "ellipse" | "line" | "triangle" | "arrow" | "star";

export interface ShapeStyle {
  readonly fill: RGBA | null;
  readonly stroke: RGBA | null;
  /** Stroke width in local px. Centred on the outline. */
  readonly strokeWidth: number;
  /** Corner radius for rectangles, local px. Clamped to half the short side. */
  readonly cornerRadius: number;
  readonly opacity: number;
  readonly blend: BlendMode;
  /** Antialiasing width in local px. 0 = hard aliased edge. */
  readonly antialias: number;
}

export interface ShapeGeometry {
  readonly kind: ShapeKind;
  /** Defining rect in local space, pre-rotation. For line/arrow these are the
   *  two endpoints' bounding box; `from`/`to` disambiguate direction. */
  readonly rect: Rect;
  /** Rotation about the rect's centre, degrees. Uses the 0–360 angle system. */
  readonly rotation: number;
   /** Temporary radius used while dragging; falls back to style.cornerRadius. */
  readonly cornerRadiusOverride?: number;
  /** Line/arrow endpoints. Ignored by the other kinds. */
  readonly from?: Vec2;
  readonly to?: Vec2;
  /** Arrow head length in local px. */
  readonly headLength?: number;
  /** Arrow head half-width in local px. */
  readonly headWidth?: number;
  /** Triangle apex as a normalized position along the rect's top edge. */
  readonly apex?: number;
}

/* ========== flood fill ========== */

export interface FloodFillSettings {
  /** Seed point, local px. Floored to a pixel centre internally. */
  readonly seed: Vec2;
  readonly color: RGBA;
  /**
   * 0..1. Compared against a normalized RGBA distance; see `colorDistance`.
   * 0 fills only exactly-equal pixels.
   */
  readonly tolerance: number;
  /** false = fill every matching pixel in the layer, ignoring connectivity. */
  readonly contiguous: boolean;
  /** 8-connected closes single-pixel diagonal gaps; 4 is the safe default. */
  readonly connectivity: 4 | 8;
  /** Dilate the filled region by N px, to close antialiased outlines. */
  readonly grow: number;
  /** Feather the region's edge by N px for a soft boundary. */
  readonly feather: number;
  readonly opacity: number;
  readonly blend: BlendMode;
  /** Match against this buffer instead of the target — lets the user fill on a
   *  new layer while sampling the flattened composite. */
  readonly sampleFrom?: Uint8ClampedArray;
}

export interface FloodFillResult {
  /** Pixels affected. 0 means the seed was out of bounds or already matched. */
  readonly pixelsFilled: number;
  readonly bounds: Rect;
}

/* ========== eyedropper ========== */

export interface EyedropperSettings {
  readonly point: Vec2;
  /** 0 = single pixel. >0 averages a disc of this radius, alpha-weighted. */
  readonly radius: number;
  /** Ignore pixels below this alpha when averaging. Stops a mostly-transparent
   *  neighbourhood from dragging the sample toward black. */
  readonly alphaThreshold: number;
}

export interface EyedropperResult {
  /** Straight, un-premultiplied. */
  readonly color: RGBA;
  readonly hex: string;
  readonly hsva: HSVA;
  /** How many pixels contributed. 0 ⇒ the sample was fully transparent. */
  readonly sampleCount: number;
}

/* ========== engine plumbing ========== */

/** A rectangular region that changed, in local px. Half-open: [x, x+w). */
export type DirtyRect = Rect;

export interface RasterCommit {
  readonly dirty: DirtyRect;
  /** Data URL of the whole surface, ready for `layer/setImage`. */
  readonly image: string;
  readonly width: number;
  readonly height: number;
}

export type BrushCursorShape = "round" | "square" | "crosshair" | "precise";
