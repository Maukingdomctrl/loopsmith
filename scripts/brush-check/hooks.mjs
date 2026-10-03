// Module resolution for running src/ under Node's built-in type stripping:
// the "@/" alias points at src/, and extensionless relative imports find
// their .ts file, as the bundler would.
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

function findTs(base) {
  for (const f of [base, `${base}.ts`, path.join(base, "index.ts")]) {
    if (f.endsWith(".ts") && existsSync(f) && statSync(f).isFile()) return f;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  let file = null;
  if (specifier.startsWith("@/")) {
    file = findTs(path.join(SRC, specifier.slice(2)));
  } else if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL?.startsWith("file:")
  ) {
    file = findTs(path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier));
  }
  if (file) return { url: pathToFileURL(file).href, format: "module-typescript", shortCircuit: true };
  return next(specifier, context);
}
