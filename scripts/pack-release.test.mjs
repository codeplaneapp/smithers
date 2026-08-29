import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  dependencyOrder,
  packResultFilename,
  publicationManifest,
  readWorkspaceManifests,
  releaseGroup,
  workspaceDependencies,
  workspaces
} from "./pack-release.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const workflow = (name) => readFileSync(join(repoRoot, ".github", "workflows", name), "utf8")

/**
 * Extracts the commands a workflow runs as gates: `pnpm run <script>`,
 * `pnpm test`, and the release scripts driven directly through node.
 */
const gateCommands = (source) =>
  new Set(
    [
      ...source.matchAll(/\bpnpm run [a-z][a-z:-]*/g),
      ...source.matchAll(/\bpnpm test\b/g),
      ...source.matchAll(/\bnode (?:--test )?scripts\/[\w.-]+\.mjs/g)
    ].map((match) => match[0])
  )

test("publicationManifest replaces source exports without mutating the input", () => {
  const manifest = {
    name: "@smthrs/example",
    exports: {
      ".": "./src/index.ts"
    },
    publishConfig: {
      access: "public",
      provenance: true,
      exports: {
        ".": {
          types: "./dist/esm/index.d.ts",
          import: "./dist/esm/index.js",
          require: "./dist/cjs/index.js"
        }
      }
    }
  }

  assert.deepEqual(publicationManifest(manifest), {
    name: "@smthrs/example",
    exports: {
      ".": {
        types: "./dist/esm/index.d.ts",
        import: "./dist/esm/index.js",
        require: "./dist/cjs/index.js"
      }
    },
    publishConfig: {
      access: "public",
      provenance: true
    }
  })
  assert.equal(manifest.exports["."], "./src/index.ts")
  assert.ok("exports" in manifest.publishConfig)
})

test("packResultFilename makes pnpm's absolute pack result portable", () => {
  assert.equal(
    packResultFilename(
      { filename: "/tmp/release/smthrs-example-0.1.0.tgz" },
      "@smthrs/example"
    ),
    "smthrs-example-0.1.0.tgz"
  )
  assert.throws(
    () => packResultFilename({}, "@smthrs/example"),
    /pnpm pack returned no filename/
  )
})

test("publicationManifest rejects a package without publication exports", () => {
  assert.throws(
    () => publicationManifest({ name: "@smthrs/example", publishConfig: { access: "public" } }),
    /publishConfig\.exports/
  )
})

test("workspaces covers every non-private engine package under packages/", () => {
  // Recomputed here rather than imported, so a change to the derivation in
  // pack-release.mjs has to agree with an independent reading of packages/.
  const packagesRoot = join(repoRoot, "packages")
  const manifests = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(packagesRoot, name, "package.json")))
    .map((name) => [name, JSON.parse(readFileSync(join(packagesRoot, name, "package.json"), "utf8"))])
  const published = manifests
    .filter(([, manifest]) => !manifest.private && manifest.smthrs?.group === "engine")
    .map(([name]) => name)

  assert.equal(releaseGroup, "engine")
  assert.deepEqual([...workspaces].sort(), published.sort())
  assert.ok(manifests.some(([, manifest]) => !manifest.private && manifest.smthrs?.group === "agent"))
  assert.ok(manifests.some(([, manifest]) => manifest.smthrs?.group === "tooling"))
})

test("pack-release lists workspace directories and package names in publication order", () => {
  const list = execFileSync(process.execPath, ["scripts/pack-release.mjs", "--list"], {
    cwd: repoRoot,
    encoding: "utf8"
  })
  const names = execFileSync(process.execPath, ["scripts/pack-release.mjs", "--names"], {
    cwd: repoRoot,
    encoding: "utf8"
  })
  const manifests = readWorkspaceManifests()

  assert.deepEqual(list.trim().split("\n"), workspaces)
  assert.deepEqual(names.trim().split("\n"), workspaces.map((directory) => manifests.get(directory).name))
})

test("pack-release order is a topological order of the workspace dependency graph", () => {
  const dependencies = workspaceDependencies(readWorkspaceManifests())
  const position = new Map(workspaces.map((name, index) => [name, index]))
  const unordered = []
  for (const [workspace, edges] of dependencies) {
    for (const edge of edges) {
      if (position.get(edge) > position.get(workspace)) unordered.push(`${workspace} -> ${edge}`)
    }
  }

  // @smthrs/kernel publishes kernel/test/TestHost, which imports
  // @smthrs/platform-browser, and platform-browser imports @smthrs/kernel
  // back. That cycle is the one edge publication order cannot respect. A
  // second entry here is a new cycle, and a new release-ordering hazard.
  assert.deepEqual(unordered.sort(), ["kernel -> platform-browser"])
})

test("release.yml publishes exactly the packed workspaces, in the packed order", () => {
  const release = workflow("release.yml")

  // The publish step reads the pack manifest, so the published set is the
  // packed set and the published order is the packed order by construction.
  assert.match(release, /manifest\.json/)
  assert.match(release, /entry\.name \+ " " \+ entry\.filename/)
  assert.deepEqual([...release.matchAll(/@smthrs\/[\w-]+/g)].map((match) => match[0]), [])
})

test("every gate in ci.yml also runs in release.yml", () => {
  const missing = [...gateCommands(workflow("ci.yml"))]
    .filter((gate) => !gateCommands(workflow("release.yml")).has(gate))

  assert.deepEqual(missing, [])
})

test("dependencyOrder is a topological order with an alphabetical tiebreak", () => {
  assert.deepEqual(
    dependencyOrder(new Map([["z", new Set()], ["a", new Set(["z"])], ["m", new Set()]])),
    ["m", "z", "a"]
  )
})

test("dependencyOrder enters a cycle at its alphabetically first member", () => {
  assert.deepEqual(
    dependencyOrder(new Map([
      ["b", new Set(["c"])],
      ["c", new Set(["b"])],
      ["a", new Set(["b", "c"])],
      ["d", new Set()]
    ])),
    ["d", "b", "c", "a"]
  )
})
