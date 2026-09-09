import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

if (!process.versions.bun) throw new Error("The Bun compatibility lane requires Bun")

// Import the JavaScript entry under the selected interpreter, bypassing pnpm's Node shim.
const require = createRequire(import.meta.url)
const entry = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs")
process.env.SMITHERS_PLATFORM_BUN_LANE = "1"
process.argv = [process.execPath, entry, "run", "--coverage.enabled=false", ...process.argv.slice(2)]
await import(pathToFileURL(entry).href)
