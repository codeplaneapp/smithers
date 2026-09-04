/**
 * The manifest contract every workspace package keeps.
 *
 * Ported from the Smithers 0.x `packages/smithers/tests/package-and-build-contract`
 * suites. The 0.x version asserted a build pipeline that no longer exists —
 * `tsup` entry points, a `dist/` layout, a bin shim — so what survives here is
 * the part that is still a claim about the shipped tree: one version across the
 * release line, a publishable surface that is actually declared, and the four
 * scripts every gate invokes.
 *
 * Run it with `node --test "scripts/repo-contract/*.test.mjs"`.
 */
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..")

/** The one version every package on the release line carries. */
const releaseVersion = "1.0.0-rc.0"

/**
 * Publishable packages that are deliberately NOT on the release line, and why.
 *
 * A package here still has to keep every other rule; it is exempt only from the
 * synchronized version. Adding a row is a review decision, which is the point of
 * enumerating them instead of loosening the assertion.
 */
const offReleaseLine = new Map([])

/**
 * The one publishable package whose whole surface is a single throwing module,
 * so it exposes no subpaths and no manifest.
 */
const manifestNotExposed = new Map([
  [
    "smthrs",
    "The 1.0 migration notice. Importing it throws; there is no subpath surface "
    + "and nothing that would read its manifest at runtime."
  ]
])

/**
 * Every directory under `packages/` that has a manifest, at any depth.
 *
 * The walk descends. A granular package can sit inside the product package it
 * belongs to — `packages/smithers/flows/canonical` is `@smthrs/canonical` — and a
 * one-level reading would both stop checking it and start failing the
 * workspace-dependency cell below, because every package that depends on
 * `@smthrs/canonical` would resolve it to nothing.
 */
const packageDirectories = (parent = "") =>
  readdirSync(join(root, "packages", parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
    .flatMap((entry) => {
      const directory = parent === "" ? entry.name : `${parent}/${entry.name}`
      return existsSync(join(root, "packages", directory, "package.json"))
        ? [directory, ...packageDirectories(directory)]
        : []
    })

const manifests = packageDirectories()
  .map((directory) => ({ directory, path: join(root, "packages", directory, "package.json") }))
  .map((entry) => ({ ...entry, manifest: JSON.parse(readFileSync(entry.path, "utf8")) }))

const publishable = manifests.filter((entry) => entry.manifest.private !== true)

describe("the workspace package contract", () => {
  it("has packages to check", () => {
    assert.ok(manifests.length > 20, `expected a populated packages/ tree, found ${manifests.length}`)
    assert.ok(publishable.length > 20, `expected publishable packages, found ${publishable.length}`)
  })

  it("keeps one version across the release line", () => {
    const offLine = publishable.filter((entry) => entry.manifest.version !== releaseVersion)
    for (const entry of offLine) {
      assert.ok(
        offReleaseLine.has(entry.manifest.name),
        `packages/${entry.directory} publishes ${entry.manifest.name}@${entry.manifest.version} instead of `
          + `${releaseVersion}. Move it onto the release line, or add it to offReleaseLine with the reason.`
      )
    }
    // The exemptions are for packages that exist. A stale row would quietly stop
    // guarding anything.
    for (const name of offReleaseLine.keys()) {
      assert.ok(
        publishable.some((entry) => entry.manifest.name === name),
        `offReleaseLine names ${name}, which is not a publishable package any more`
      )
    }
  })

  it("declares a publishable surface for every published package", () => {
    for (const entry of publishable) {
      const { manifest } = entry
      const where = `packages/${entry.directory}`
      assert.equal(manifest.type, "module", `${where} must be an ES module`)
      assert.equal(manifest.license, "MIT", `${where} must declare its licence`)
      assert.equal(manifest.publishConfig?.access, "public", `${where} must publish publicly`)
      assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, `${where} must declare files`)
      assert.ok(manifest.exports?.["."], `${where} must declare a root export`)
      if (!manifestNotExposed.has(manifest.name)) {
        assert.equal(
          manifest.exports?.["./package.json"],
          "./package.json",
          `${where} must expose its own manifest, which tooling reads`
        )
      }
      assert.equal(manifest.repository?.directory, where, `${where} must name its own directory in repository`)
      assert.ok(manifest.engines?.node, `${where} must declare the Node range it supports`)
    }
  })

  it("tags the release line so an RC never lands on the latest dist-tag", () => {
    for (const entry of publishable) {
      if (offReleaseLine.has(entry.manifest.name)) continue
      assert.equal(
        entry.manifest.publishConfig?.tag,
        "next",
        `packages/${entry.directory} would publish to the default dist-tag, which is how a release candidate `
          + "becomes somebody's `npm install` by accident"
      )
    }
  })

  it("wires the scripts every gate invokes", () => {
    for (const entry of publishable) {
      const scripts = entry.manifest.scripts ?? {}
      for (const name of ["lint", "build", "check", "test", "coverage"]) {
        assert.ok(scripts[name], `packages/${entry.directory} is missing scripts.${name}`)
      }
    }
  })

  it("resolves every workspace dependency to a package that exists at the version it names", () => {
    const byName = new Map(manifests.map((entry) => [entry.manifest.name, entry.manifest]))
    for (const entry of manifests) {
      const dependencies = { ...entry.manifest.dependencies, ...entry.manifest.peerDependencies }
      for (const [name, range] of Object.entries(dependencies)) {
        if (!name.startsWith("@smthrs/")) continue
        const target = byName.get(name)
        assert.ok(target, `packages/${entry.directory} depends on ${name}, which is not in this workspace`)
        if (entry.manifest.private === true) {
          // A private package is never published, so the `workspace:` protocol
          // never reaches a consumer and an exact pin buys nothing.
          assert.ok(
            range === target.version || range.startsWith("workspace:"),
            `packages/${entry.directory} pins ${name}@${range}, which is neither the workspace version `
              + `${target.version} nor a workspace protocol range`
          )
          continue
        }
        assert.equal(
          range,
          target.version,
          `packages/${entry.directory} is published and pins ${name}@${range} rather than the workspace version `
            + `${target.version}; a published \`workspace:\` range is an unresolvable dependency for a consumer`
        )
      }
    }
  })

  it("never lets a published package depend on a private one", () => {
    const privateNames = new Set(
      manifests.filter((entry) => entry.manifest.private === true).map((entry) => entry.manifest.name)
    )
    for (const entry of publishable) {
      for (const name of Object.keys(entry.manifest.dependencies ?? {})) {
        assert.ok(
          !privateNames.has(name),
          `packages/${entry.directory} publishes a dependency on ${name}, which is never published`
        )
      }
    }
  })

  it("keeps every published Effect runtime dependency as an exact peer and workspace dev dependency", () => {
    const substrate = ["effect", "@effect/platform-node", "@effect/platform-node-shared"]
    for (const entry of publishable) {
      for (const name of substrate) {
        const declared = ["dependencies", "peerDependencies"]
          .some((field) => entry.manifest[field]?.[name] !== undefined)
        if (!declared) continue
        const where = `packages/${entry.directory}`
        assert.equal(
          entry.manifest.peerDependencies?.[name],
          "4.0.0-rc.108",
          `${where} must constrain ${name} as an exact peer`
        )
        assert.equal(
          entry.manifest.dependencies?.[name],
          undefined,
          `${where} must not install a private ${name} copy`
        )
        assert.equal(
          entry.manifest.devDependencies?.[name],
          "4.0.0-rc.108",
          `${where} must install ${name} for its own checks`
        )
      }
    }
  })

  it("pins the gateway's complete Node Effect peer set", () => {
    const gateway = publishable.find((entry) => entry.manifest.name === "@smthrs/gateway")
    assert.ok(gateway, "@smthrs/gateway must be publishable")

    for (const name of ["effect", "@effect/platform-node", "@effect/platform-node-shared"]) {
      assert.equal(gateway.manifest.peerDependencies?.[name], "4.0.0-rc.108", `${name} peer`)
      assert.equal(gateway.manifest.devDependencies?.[name], "4.0.0-rc.108", `${name} dev dependency`)
      assert.equal(gateway.manifest.dependencies?.[name], undefined, `${name} hard dependency`)
    }
  })

  it("keeps kernel's browser test host out of the runtime graph", () => {
    const kernel = publishable.find((entry) => entry.manifest.name === "@smthrs/kernel")
    assert.ok(kernel, "@smthrs/kernel must be publishable")

    assert.equal(kernel.manifest.dependencies?.["@smthrs/platform-browser"], undefined)
    assert.equal(kernel.manifest.devDependencies?.["@smthrs/platform-browser"], releaseVersion)
    assert.equal(kernel.manifest.peerDependencies?.["@smthrs/platform-browser"], releaseVersion)
    assert.equal(kernel.manifest.peerDependenciesMeta?.["@smthrs/platform-browser"]?.optional, true)
  })

  it("requires the Bun platform peer imported by the root entry point", () => {
    const platform = publishable.find((entry) => entry.manifest.name === "@smthrs/platform-bun")
    assert.ok(platform, "@smthrs/platform-bun must be publishable")

    assert.equal(platform.manifest.peerDependencies?.["@effect/platform-bun"], "4.0.0-rc.108")
    assert.notEqual(platform.manifest.peerDependenciesMeta?.["@effect/platform-bun"]?.optional, true)
  })
})
