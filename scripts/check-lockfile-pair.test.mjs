// The claims check-lockfile-pair.mjs makes about the two lockfiles, pinned as
// assertions instead of as console output.
//
// The cells run over the real tree: the real workspace manifests, the real
// `pnpm-lock.yaml` importers block, the real `bun.lock`. There is no synthetic
// fixture, because the drift this guards exists only between the committed
// files.
//
// Run it with `node --test scripts/check-lockfile-pair.test.mjs`.
import { describe, it } from "node:test"
import assert from "node:assert/strict"

import { collectDrift, collectManifestDirectories, parseBunLock, parsePnpmImporters } from "./check-lockfile-pair.mjs"

describe("check-lockfile-pair", () => {
  it("sees every workspace manifest in both lockfiles", () => {
    const directories = collectManifestDirectories()
    assert.ok(directories.length > 10, `only ${directories.length} manifests found — the workspace scan broke`)
    const importers = parsePnpmImporters()
    const bunWorkspaces = parseBunLock().workspaces
    for (const directory of directories) {
      assert.ok(importers.has(directory), `${directory} missing from pnpm-lock.yaml importers`)
      assert.ok(
        (directory === "." ? "" : directory) in bunWorkspaces,
        `${directory} missing from bun.lock workspaces`
      )
    }
  })

  it("parses non-empty importer sections, not just importer paths", () => {
    // A parser that stopped reading `specifier:` lines would see every
    // importer as empty and pass vacuously.
    const importers = parsePnpmImporters()
    const withDeps = [...importers.values()].filter((sections) => sections.size > 0)
    assert.ok(withDeps.length > 10, "the importers parser read no dependency sections")
  })

  it("reports no drift on the committed tree", () => {
    const { pnpmDrift, bunDrift } = collectDrift()
    assert.deepEqual(pnpmDrift, [], "pnpm-lock.yaml is stale; repair: pnpm install --lockfile-only")
    assert.deepEqual(bunDrift, [], "bun.lock is stale; repair: bun install --lockfile-only")
  })
})
