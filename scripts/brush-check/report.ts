/**
 * The check report, shared by every section of brush:check. The line format
 * is what the QA pipeline parses (scripts/qa/qa.mjs `brushCheck`): keep it.
 */

let failures = 0;

export function check(label: string, value: number, limit: number, unit = "", lower = false): void {
  const ok = lower ? value >= limit : value <= limit;
  if (!ok) failures++;
  const v = Number.isInteger(value) ? String(value) : value.toFixed(3);
  console.log(`  ${ok ? "pass" : "FAIL"}  ${label.padEnd(58)} ${(v + unit).padStart(10)}   ${lower ? "≥" : "≤"} ${limit}${unit}`);
}

export const section = (title: string) => console.log(`\n${title}`);

export const failureCount = (): number => failures;
