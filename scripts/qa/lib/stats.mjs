// Small statistics used by the reports.

/** The middle value (the lower middle for an even count, as the reports
 *  have always used). */
export function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

/** The value below which a share `q` (0…1) of the values fall. */
export function quantile(values, q) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
