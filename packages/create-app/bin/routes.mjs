#!/usr/bin/env node
// `smithers-routes`: regenerate routes.gen.ts and routes.ui.gen.ts at an app
// root. `--check` writes nothing and exits 1 on drift. The build graph checks
// drift through `smithers-build lint '//:routes'`, which runs the generator in
// write mode and compares the declared `changes`; the bare `smithers-build
// '//:routes'` form is the write form and checks nothing.
//
// A published install ships `dist/esm/routesBin.js`, and Node refuses to strip
// types from any file under node_modules, so the built entry is preferred
// whenever it exists. A source checkout has no `dist`, so the source module
// runs through Node's own type stripping and `pnpm exec smithers-routes` needs
// no build step.
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const built = new URL("../dist/esm/routesBin.js", import.meta.url)
let entry = built

if (!existsSync(fileURLToPath(built))) {
  // Type stripping is experimental on Node 22, and its warning would prepend a
  // paragraph of noise to every development invocation. Only that one warning
  // is dropped; everything else still reaches stderr.
  const emitWarning = process.emitWarning.bind(process)
  process.emitWarning = (warning, ...rest) => {
    const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type
    if (type === "ExperimentalWarning" && String(warning).includes("Type Stripping")) return
    emitWarning(warning, ...rest)
  }
  entry = new URL("../src/routesBin.ts", import.meta.url)
}

const { runRoutesBin } = await import(entry.href)

// `process.exitCode` rather than `process.exit`, so a report written to a pipe
// is flushed before the process ends.
process.exitCode = runRoutesBin(process.argv.slice(2), {
  io: { out: (line) => console.log(line), err: (line) => console.error(line) }
})
