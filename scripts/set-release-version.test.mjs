import assert from "node:assert/strict"
import test from "node:test"
import { mismatches, readManifests, retarget } from "./set-release-version.mjs"

const workspaceNames = new Set(["@smthrs/kernel", "@smthrs/flows"])

const example = {
  name: "@smthrs/flows",
  version: "0.1.0",
  dependencies: {
    "@smthrs/kernel": "0.1.0",
    effect: "4.0.0-rc.108"
  },
  devDependencies: {
    "@smthrs/kernel": "workspace:*",
    vitest: "4.1.9"
  }
}

test("retarget moves the version and the exact workspace ranges together", () => {
  assert.deepEqual(retarget(example, "0.1.0-next.0", workspaceNames), {
    name: "@smthrs/flows",
    version: "0.1.0-next.0",
    dependencies: {
      "@smthrs/kernel": "0.1.0-next.0",
      effect: "4.0.0-rc.108"
    },
    devDependencies: {
      // A protocol range carries no version, so it cannot drift.
      "@smthrs/kernel": "workspace:*",
      vitest: "4.1.9"
    }
  })
  assert.equal(example.version, "0.1.0")
})

test("retarget leaves third-party ranges alone", () => {
  const retargeted = retarget(example, "9.9.9", new Set())
  assert.equal(retargeted.dependencies["@smthrs/kernel"], "0.1.0")
  assert.equal(retargeted.version, "9.9.9")
})

test("retarget preserves private versions while updating exact workspace ranges", () => {
  const privateManifest = { ...example, private: true, version: "0.0.0" }
  const retargeted = retarget(privateManifest, "0.1.0-next.0", workspaceNames)
  assert.equal(retargeted.version, "0.0.0")
  assert.equal(retargeted.dependencies["@smthrs/kernel"], "0.1.0-next.0")
})

test("mismatches names the version and every stale internal range", () => {
  const entries = [
    { directory: "packages/flows", manifest: example },
    {
      directory: "packages/kernel",
      manifest: { name: "@smthrs/kernel", version: "0.1.0-next.0" }
    }
  ]

  assert.deepEqual(mismatches(entries, "0.1.0-next.0"), [
    "packages/flows: version is 0.1.0, expected 0.1.0-next.0",
    "packages/flows: dependencies.@smthrs/kernel is 0.1.0, expected 0.1.0-next.0"
  ])
  assert.deepEqual(mismatches(entries.slice(1), "0.1.0-next.0"), [])
})

test("this workspace is internally coherent at its current version", () => {
  const entries = readManifests()
  const version = entries.find(({ directory }) => directory === "packages/flows").manifest.version

  assert.deepEqual(mismatches(entries, version), [])
})

test("workspace discovery follows every pnpm-workspace package glob", () => {
  const directories = new Set(readManifests().map(({ directory }) => directory))
  assert.equal(directories.has("packages/build/infra"), true)
  assert.equal(directories.has("examples"), true)
  assert.equal(directories.has("apps/server"), true)
  assert.equal(directories.has("apps/shared"), true)
  assert.equal(directories.has("apps/tui"), true)
  assert.equal(directories.has("apps/ui"), true)
})
