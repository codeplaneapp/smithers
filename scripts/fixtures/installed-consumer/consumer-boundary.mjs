/** Fail when a copied program accidentally resolves against a workspace install. */
import assert from "node:assert/strict"
import { readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

export const assertInstalledConsumer = (url) => {
  const root = realpathSync(dirname(fileURLToPath(url)))
  const manifestPath = join(root, "package.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  assert.equal(manifest.smthrsReleaseConsumer, true, "fixture must execute in a prepared installed consumer")
  const require = createRequire(manifestPath)
  const selected = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => name.startsWith("@smthrs/") || name.startsWith("@effect/") || name === "effect" || name === "vitest")
  assert.ok(selected.length > 0, "consumer selects no runtime packages")
  for (const name of selected) {
    const installed = realpathSync(require.resolve(name + "/package.json"))
    const path = relative(join(root, "node_modules"), installed)
    assert.ok(path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path),
      `${name} resolved outside the installed consumer: ${installed}`)
  }
}
