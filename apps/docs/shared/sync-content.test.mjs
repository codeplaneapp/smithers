import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Run the actual sync CLI against an isolated source package and site. */
const fixture = (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-sync-content-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  copyFileSync(new URL("./sync-content.mjs", import.meta.url), join(root, "sync-content.mjs"))
  writeFileSync(join(root, "manifest.mjs"), `
    export const repoRoot = ${JSON.stringify(root)}
    export const docsRoot = repoRoot + "/sites"
    export const sites = [{ slug: "fixture", name: "fixture", description: "Fixture docs",
      dir: "package", siteDir: docsRoot + "/fixture" }]
    export const bySlug = new Map(sites.map((site) => [site.slug, site]))
  `)
  const source = join(root, "package/docs")
  const output = join(root, "sites/fixture/src/content/docs")
  mkdirSync(join(source, "guides/nested"), { recursive: true })
  writeFileSync(join(source, "README.md"), "# Fixture\n\nOverview.\n")
  writeFileSync(join(source, "guides/nested/page.md"), "# Page\n\nNested page.\n")
  const run = (nodeArgs, args) => execFileSync(process.execPath, [...nodeArgs, join(root, "sync-content.mjs"), "fixture", ...args], {
    cwd: root, encoding: "utf8", stdio: "pipe", timeout: 30_000
  })
  const sync = (...args) => run([], args)
  const syncWithHook = (code) => {
    const hook = join(root, "hook.mjs")
    writeFileSync(hook, code)
    return run(["--import", hook], [])
  }
  return { source, output, sync, syncWithHook }
}

test("deleting the last nested page prunes empty parents and the next sync is a no-op", (t) => {
  const { source, output, sync } = fixture(t)
  sync()
  assert.ok(existsSync(join(output, "guides/nested/page.md")))
  const index = join(output, "index.md")
  const content = readFileSync(index, "utf8")
  const mtime = statSync(index).mtimeMs

  rmSync(join(source, "guides/nested/page.md"))
  assert.match(sync(), /synced fixture: 1 drifted/)
  assert.equal(existsSync(join(output, "guides")), false)
  assert.deepEqual(readdirSync(output), ["index.md"])

  assert.match(sync(), /synced fixture: clean/)
  assert.deepEqual(readdirSync(output), ["index.md"])
  assert.equal(readFileSync(index, "utf8"), content)
  assert.equal(statSync(index).mtimeMs, mtime)
  assert.match(sync("--check"), /checked fixture: clean/)
})

test("pruning keeps nonempty parents and unprojected assets", (t) => {
  const { source, output, sync } = fixture(t)
  sync()
  const asset = join(output, "guides/asset.svg")
  writeFileSync(asset, "<svg />\n")
  rmSync(join(source, "guides/nested/page.md"))

  assert.match(sync(), /synced fixture: 1 drifted/)
  assert.equal(existsSync(join(output, "guides/nested")), false)
  assert.equal(readFileSync(asset, "utf8"), "<svg />\n")
  assert.match(sync(), /synced fixture: clean/)
})

for (const race of ["removed", "refilled"]) {
  test(`pruning tolerates a directory ${race} between the empty check and removal`, (t) => {
    const { source, output, sync, syncWithHook } = fixture(t)
    sync()
    rmSync(join(source, "guides/nested/page.md"))
    const nested = join(output, "guides/nested")
    const result = syncWithHook(`
      import fs from "node:fs"
      import { syncBuiltinESMExports } from "node:module"
      const rmdir = fs.rmdirSync
      fs.rmdirSync = (path, options) => {
        if (path === ${JSON.stringify(nested)}) {
          ${race === "removed" ? "rmdir(path)" : 'fs.writeFileSync(path + "/asset.svg", "<svg />\\n")'}
        }
        return rmdir(path, options)
      }
      syncBuiltinESMExports()
    `)
    assert.match(result, /synced fixture: 1 drifted/)
    if (race === "removed") {
      assert.equal(existsSync(join(output, "guides")), false)
    } else {
      assert.equal(readFileSync(join(nested, "asset.svg"), "utf8"), "<svg />\n")
    }
    assert.match(sync(), /synced fixture: clean/)
  })
}
