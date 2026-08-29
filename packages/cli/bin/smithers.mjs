#!/usr/bin/env node
/**
 * The `smithers` executable.
 *
 * The shebang pins Node for every installation path — `npm install -g`, `npx`,
 * and `bun x --package @smthrs/cli smithers` — because the durable engine is
 * unsupported on Bun (rc-contract.md section 1). Bun honours the shebang unless
 * `--bun` is passed, and `--bun` execution of this CLI is unsupported.
 *
 * A published install ships `dist/esm/bin.js`, so the shim runs the built
 * entry. A source checkout has no `dist`, so it runs `src/bin.ts` through
 * Node's own type stripping — the same path `test/Bin.test.ts` executes. That
 * is what makes `pnpm exec smithers` run the working tree during development
 * with no build step, which `scripts/check-local-smithers.mjs` requires.
 */
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const built = new URL("../dist/esm/bin.js", import.meta.url)

if (existsSync(fileURLToPath(built))) {
  await import(built.href)
} else {
  // Type stripping is experimental on Node 22, and its warning would prepend a
  // paragraph of noise to every development invocation. Only that one warning
  // is dropped; everything else still reaches stderr.
  const emitWarning = process.emitWarning.bind(process)
  process.emitWarning = (warning, ...rest) => {
    const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type
    if (type === "ExperimentalWarning" && String(warning).includes("Type Stripping")) return
    emitWarning(warning, ...rest)
  }
  await import(new URL("../src/bin.ts", import.meta.url).href)
}
