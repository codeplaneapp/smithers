import { execFileSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it } from "vitest"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const esmEntry = join(packageRoot, "dist/esm/index.js")
const cjsEntry = join(packageRoot, "dist/cjs/index.js")
const artifactsAvailable = existsSync(esmEntry) && existsSync(cjsEntry)
const testName = artifactsAvailable
  ? "imports every published ESM and CJS subpath with one root identity"
  : "requires `pnpm --filter @smthrs/plugin build` before published artifact checks can run"

describe("built artifacts", () => {
  it.skipIf(!artifactsAvailable)(
    testName,
    () => {
      const temporaryRoot = mkdtempSync(join(tmpdir(), "smthrs-plugin-artifacts-"))
      try {
        const installedPackage = join(temporaryRoot, "node_modules/@smthrs/plugin")
        mkdirSync(installedPackage, { recursive: true })

        const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
          exports: unknown
          publishConfig?: { readonly exports?: unknown }
        }
        manifest.exports = manifest.publishConfig?.exports
        delete manifest.publishConfig
        writeFileSync(join(installedPackage, "package.json"), `${JSON.stringify(manifest, undefined, 2)}\n`)
        symlinkSync(
          join(packageRoot, "dist"),
          join(installedPackage, "dist"),
          process.platform === "win32" ? "junction" : "dir"
        )

        for (const fixture of ["artifact-esm.mjs", "artifact-cjs.cjs"]) {
          copyFileSync(join(packageRoot, "test/fixtures", fixture), join(temporaryRoot, fixture))
          execFileSync(process.execPath, [fixture], { cwd: temporaryRoot })
        }
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true })
      }
    },
    60_000
  )
})
