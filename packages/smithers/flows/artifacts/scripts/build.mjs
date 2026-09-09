import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const tsc = resolve(packageRoot, "node_modules/typescript/bin/tsc")

const filesWithExtension = (directory, extension) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? filesWithExtension(path, extension) : entry.name.endsWith(extension) ? [path] : []
  })

rmSync(resolve(packageRoot, "dist"), { recursive: true, force: true })
// A wedged compiler would otherwise hold the build open for as long as the
// caller allows. `spawnSync` enforces this bound itself, and SIGKILL leaves
// nothing behind for the caller's own deadline to have to clean up.
const declarationTimeoutMs = 90_000
const declarationResult = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
  cwd: packageRoot,
  stdio: "inherit",
  timeout: declarationTimeoutMs,
  killSignal: "SIGKILL"
})
if (declarationResult.error !== undefined) {
  console.error(`tsc did not finish within ${declarationTimeoutMs} ms: ${declarationResult.error.message}`)
  process.exit(1)
}
if (declarationResult.status !== 0) process.exit(declarationResult.status ?? 1)

await build({
  entryPoints: filesWithExtension(resolve(packageRoot, "src"), ".ts"),
  outbase: resolve(packageRoot, "src"),
  outdir: resolve(packageRoot, "dist/cjs"),
  format: "cjs",
  bundle: false,
  platform: "neutral",
  target: "es2022",
  sourcemap: true
})

for (const file of filesWithExtension(resolve(packageRoot, "dist/cjs"), ".js")) {
  const source = readFileSync(file, "utf8")
  writeFileSync(
    file,
    source.replace(
      /(require\(["'](?:\.\.?\/)[^"']+)\.ts(["']\))/g,
      "$1.js$2"
    )
  )
}

mkdirSync(resolve(packageRoot, "dist/cjs"), { recursive: true })
writeFileSync(resolve(packageRoot, "dist/cjs/package.json"), '{\n  "type": "commonjs"\n}\n')
