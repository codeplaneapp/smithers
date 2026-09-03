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
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { danglingWorkspaceLinkHint } from "./dangling-workspace-links.mjs"

const built = new URL("../dist/esm/bin.js", import.meta.url)

/**
 * The refusal a removed 0.x verb earns, answered here, before the entry point
 * and its module graph load.
 *
 * `bin.ts` refuses the same vectors through `Unsupported.refusal` before its
 * runtime boots, but by then the process has imported the platform, the
 * database driver, and the command tree, which is most of a second on an idle
 * machine and many seconds on a loaded one. A refusal is one sentence and
 * exit 1; it needs the removal table and nothing else, and the table's module
 * imports only the error type. The sentence is a constant of the table, so it
 * carries nothing the redacting reporter would have to hide.
 */
const refusal = async () => {
  const builtTable = new URL("../dist/esm/Unsupported.js", import.meta.url)
  const table = existsSync(fileURLToPath(builtTable))
    ? builtTable.href
    : new URL("../src/Unsupported.ts", import.meta.url).href
  const Unsupported = await import(table)
  return Unsupported.refusal(process.argv.slice(2))
}

/**
 * Imports the entry, and explains the one failure whose message names the
 * wrong problem: a checkout whose workspace links point into a git worktree
 * that has since been removed fails with `ERR_MODULE_NOT_FOUND` for a package
 * that is right there in the tree. The 0.x bin diagnosed this; without the
 * diagnosis the reader looks for a build problem that does not exist.
 */
const start = async (entry) => {
  try {
    await import(entry)
  } catch (cause) {
    if (cause?.code !== "ERR_MODULE_NOT_FOUND") throw cause
    const hint = danglingWorkspaceLinkHint(dirname(fileURLToPath(import.meta.url)))
    if (hint === null) throw cause
    process.stderr.write(`${hint}\n`)
    throw cause
  }
}

// Type stripping is experimental on Node 22, and its warning would prepend a
// paragraph of noise to every development invocation. Only that one warning
// is dropped; everything else still reaches stderr.
const emitWarning = process.emitWarning.bind(process)
process.emitWarning = (warning, ...rest) => {
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type
  if (type === "ExperimentalWarning" && String(warning).includes("Type Stripping")) return
  emitWarning(warning, ...rest)
}

const refused = await refusal()
if (refused !== undefined) {
  process.stderr.write(`${refused.message}\n`)
  process.exit(1)
}

await start(existsSync(fileURLToPath(built)) ? built.href : new URL("../src/bin.ts", import.meta.url).href)
