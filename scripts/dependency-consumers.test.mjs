import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { adapterProfiles, candidateVersion, migrationProfiles, minimalProfiles, runConsumerProfile, templateProfile } from "./fixtures/dependency-consumers.mjs"
import { releaseRegistry } from "./release-registry.mjs"

test("every library, adapter and migration profile selects the supplied candidate version", () => {
  for (const version of ["1.0.0", "1.1.0-rc.7"]) {
    const entries = [{ name: "@smthrs/database", version }]
    const profiles = [...minimalProfiles(entries), ...adapterProfiles(entries), ...migrationProfiles(entries)]
    assert.equal(profiles.length, 12)
    for (const profile of profiles) {
      const firstParty = Object.entries(profile.dependencies).filter(([name]) => name.startsWith("@smthrs/"))
      assert.ok(firstParty.length > 0, profile.name)
      for (const [name, range] of firstParty) assert.equal(range, version, `${profile.name}: ${name}`)
      assert.equal(profile.dependencies.effect, "4.0.0-rc.112")
    }
  }
})

test("candidate selection rejects empty, mixed and non-exact versions", () => {
  for (const entries of [[], [{ version: "1.0.0" }, { version: "1.0.0-rc.0" }],
    [{ version: "^1.0.0" }], [{ version: "v1.0.0" }], [{}]]) {
    assert.throws(() => candidateVersion(entries), /candidate/)
  }
})

test("consumer and packed template requests resolve against a stable-only candidate registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-consumer-version-"))
  let registry
  const previousRegistry = process.env.npm_config_registry
  try {
    const version = "1.0.0"
    const entries = []
    for (const name of ["database", "create-app"]) {
      const directory = join(root, name)
      mkdirSync(join(directory, "package/template/default"), { recursive: true })
      writeFileSync(join(directory, "package/package.json"), JSON.stringify({ name: "@smthrs/" + name, version,
        dependencies: { effect: "4.0.0-rc.112" } }))
      writeFileSync(join(directory, "package/template/default/package.json"), JSON.stringify({
        private: true, dependencies: { "@smthrs/database": version }, devDependencies: { "@smthrs/create-app": version }
      }))
      const filename = name + ".tgz"
      execFileSync("tar", ["-czf", join(root, filename), "-C", directory, "package"])
      entries.push({ name: "@smthrs/" + name, version, filename })
    }
    mkdirSync(join(root, "effect/package"), { recursive: true })
    writeFileSync(join(root, "effect/package/package.json"), JSON.stringify({ name: "effect", version: "4.0.0-rc.112" }))
    execFileSync("tar", ["-czf", join(root, "effect.tgz"), "-C", join(root, "effect"), "package"])
    registry = await releaseRegistry(root, [...entries, { name: "effect", version: "4.0.0-rc.112", filename: "effect.tgz" }])
    // All package bytes, including the minimal Effect identity fixture, come
    // from loopback. No existing publication or external install is needed.
    process.env.npm_config_registry = registry.url
    const profiles = [minimalProfiles(entries)[0], templateProfile(root, entries)]
    for (const profile of profiles) {
      for (const [name, requested] of Object.entries(profile.dependencies)) {
        if (!name.startsWith("@smthrs/")) continue
        const response = await fetch(`${registry.url}/${encodeURIComponent(name)}`)
        assert.equal(response.status, 200)
        const metadata = await response.json()
        assert.deepEqual(Object.keys(metadata.versions), [version])
        assert.ok(metadata.versions[requested], `${profile.name} requested unavailable ${name}@${requested}`)
      }
    }
    for (const manager of ["npm", "pnpm"]) {
      const installed = await runConsumerProfile(profiles[0], manager, registry.url)
      assert.equal(installed.effectCopies.length, 1)
    }
    writeFileSync(join(root, "create-app/package/template/default/package.json"), JSON.stringify({
      private: true, dependencies: { "@smthrs/database": "1.0.0-rc.0" }
    }))
    execFileSync("tar", ["-czf", join(root, "create-app.tgz"), "-C", join(root, "create-app"), "package"])
    assert.throws(() => templateProfile(root, entries), /shipped template @smthrs\/database must select candidate 1\.0\.0/)
  } finally {
    if (previousRegistry === undefined) delete process.env.npm_config_registry
    else process.env.npm_config_registry = previousRegistry
    await registry?.close()
    rmSync(root, { recursive: true, force: true })
  }
})
