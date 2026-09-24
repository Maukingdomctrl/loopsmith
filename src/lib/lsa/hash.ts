/**
 * LSA v1.0 — deterministic content hashing.
 *
 * Two consumers:
 *  1. Memoization. `frame.image` is a data URL replaced wholesale on every
 *     lasso commit, so identity comparison is useless; hashing the decoded
 *     pixels lets the signal pyramid survive re-renders that changed nothing.
 *  2. Determinism auditing. RunProvenance carries the input hashes, so a test
 *     can assert: same hashes + same constants fingerprint ⇒ identical output.
 *
 * FNV-1a, two independent 32-bit lanes combined into a 64-bit hex digest.
 * No BigInt: `Math.imul` is exact 32-bit and orders of magnitude faster over
 * the ~65 kB buffers involved.
 */

const FNV_OFFSET_A = 0x811c9dc5;
const FNV_OFFSET_B = 0x1000193b;
const FNV_PRIME = 0x01000193;

/** FNV-1a over an RGBA buffer plus its dimensions. Dimensions are folded in
 *  first so that two buffers with equal bytes but different strides differ. */
export function hashImageData(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number
): string {
  let a = FNV_OFFSET_A ^ width;
  a = Math.imul(a, FNV_PRIME) >>> 0;
  a = (a ^ height) >>> 0;
  a = Math.imul(a, FNV_PRIME) >>> 0;

  let b = FNV_OFFSET_B ^ height;
  b = Math.imul(b, FNV_PRIME) >>> 0;
  b = (b ^ width) >>> 0;
  b = Math.imul(b, FNV_PRIME) >>> 0;

  const n = rgba.length;

  // Fixed forward traversal; no unrolling that would reorder the reduction.
  for (let i = 0; i < n; i++) {
    const v = rgba[i];
    a = Math.imul(a ^ v, FNV_PRIME) >>> 0;
    b = Math.imul(b ^ (v + i), FNV_PRIME) >>> 0;
  }

  return (
    a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0")
  );
}

/** Fold a list of digests into one, order-sensitively. Used for run provenance. */
export function combineHashes(hashes: readonly string[]): string {
  let a = FNV_OFFSET_A;
  const joined = hashes.join(":");
  for (let i = 0; i < joined.length; i++) {
    a = Math.imul(a ^ joined.charCodeAt(i), FNV_PRIME) >>> 0;
  }
  return a.toString(16).padStart(8, "0");
}
