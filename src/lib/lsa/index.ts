/**
 * LSA v1.0 — public surface.
 *
 * THE ONLY IMPORT PATH FOR APP CODE. Everything else under lib/lsa is internal:
 * app code that reaches past this barrier couples itself to stage internals and
 * defeats the layering that makes the engine portable (a CLI batch tool or a
 * server-side sheet preprocessor is a realistic near-term ask for an emoji
 * pipeline, and neither can import React).
 *
 * Enforce with an ESLint rule:
 *   "no-restricted-imports": ["error", { patterns: ["@/lib/lsa/*", "!@/lib/lsa"] }]
 */

/* ---- types (all of them; they are declaration-only) ---- */
export type {
  ApplyOptions,
  ConstraintGraph,
  CurlResidual,
  CycleSpec,
  DecodedFrame,
  DisplacementSpace,
  EdgeRejectionReason,
  EdgeSpec,
  FrameContentHash,
  FrameIndex,
  FrameQuality,
  FrameSignal,
  IrlsIterate,
  Lag,
  LSAResult,
  Mat2Spectrum,
  PairwiseConstraint,
  PixelBox,
  ProgressEvent,
  RobustScale,
  RunProvenance,
  SignalLevel,
  SignalPlane,
  SolverSolution,
  SolverStatistics,
  SpectralDecision,
  SpectralPolicy,
  StabilizeOptions,
  StabilizeRequest,
  StageTimings,
  SymMat2,
  TranslatableFrame,
  TranslationVector,
  WeightedEdge,
} from "./types";

/* ---- entry points ---- */
export { stabilize, LsaCancelledError, type StabilizeHooks } from "./stabilize";
export {
  assignStabilization,
  clearStabilization,
  scaleStabilization,
  type StabilizableFrame,
} from "./apply";
export {
  decodeFrame,
  decodeFrames,
  LsaDecodeError,
  type LsaDecodeErrorCode,
} from "./decode";

/* ---- configuration ---- */
export {
  DEFAULT_OPTIONS,
  DEFAULT_SPECTRAL_POLICY,
  MAX_FRAMES,
  MIN_FRAMES,
  constantsFingerprint,
} from "./constants";

/* ---- coordinate contract (needed by callers that pre-compute baseScale) ---- */
export {
  LSA_CANVAS_SIZE,
  bitmapToFrame,
  bitmapToFrameScale,
  bitmapVector,
  frameToBitmap,
  frameVector,
  type CoordContext,
} from "./coords";

/* ---- caching ---- */
export { createSignalCache, type SignalCache } from "./signal";

/* ---- diagnostics worth exposing to a debug panel ---- */
export { CURL_THRESHOLD } from "./curl";
export { ringResidualUniformity } from "./diagnostics";
export { EIGEN_DIAGNOSTIC_MAX_DIM } from "./solver";

/* ---- worker transport ---- */
export {
  LsaWorkerClient,
  runStabilizeInWorker,
  type LsaWorkerRequest,
  type LsaWorkerResponse,
} from "./worker/client";
