#!/usr/bin/env node
// `smthrs-routes`: regenerate routes.gen.ts and routes.ui.gen.ts at an app
// root. `--check` writes nothing and exits 1 on drift, which is the form
// `smthrs '//:routes'` runs.
//
// Runs under Node's built-in type stripping: every module it reaches is
// erasable syntax only.
import { defaultDirs } from "../src/app.ts"
import { writeRoutes } from "../src/router.ts"

const argv = process.argv.slice(2)

const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = argv[index + 1]
  if (value === undefined || value.startsWith("--")) {
    console.error(`--${name} expects a value`)
    process.exit(2)
  }
  return value
}

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    "usage: smthrs-routes [--check] [--root <dir>] [--app <dir>] [--flows <dir>] [--tools <dir>]\n\n" +
      "  --check  report drift instead of writing; exit 1 when a file is stale"
  )
  process.exit(0)
}

const root = flag("root", process.cwd())
const dirs = {
  app: flag("app", defaultDirs.app),
  flows: flag("flows", defaultDirs.flows),
  tools: flag("tools", defaultDirs.tools)
}
const check = argv.includes("--check")

let report
try {
  report = writeRoutes({ root, dirs, check })
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause))
  process.exit(1)
}

if (check) {
  for (const file of report.stale) console.error(`${file} is out of date; run \`pnpm routes\``)
  process.exit(report.stale.length === 0 ? 0 : 1)
}

const { flows, pages, panes } = report.counts
console.log(`routes: ${pages} pages, ${panes} panes, ${flows} flows`)
