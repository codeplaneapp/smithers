import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  defaultBindings,
  dependencyOrder,
  esmOnlyModules,
  packResultFilename,
  publicationManifest,
  publishedPackages,
  readWorkspaceManifests,
  releaseGroups,
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

test("workspaces covers every non-private engine and agent package under packages/", () => {
  // Recomputed here rather than imported, so a change to the derivation in
  // pack-release.mjs has to agree with an independent reading of packages/.
  const packagesRoot = join(repoRoot, "packages")
  const manifests = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(packagesRoot, name, "package.json")))
    .map((name) => [name, JSON.parse(readFileSync(join(packagesRoot, name, "package.json"), "utf8"))])
  const published = manifests
    .filter(([, manifest]) => !manifest.private && releaseGroups.has(manifest.smthrs?.group))
    .map(([name]) => name)

  assert.deepEqual([...releaseGroups].sort(), ["agent", "engine"])
  assert.deepEqual([...workspaces].sort(), published.sort())
  // Every tooling package is private. The build graph, its CLI, the typed
  // BUILD.ts rules, and the hosted cache deployment are workspace machinery,
  // not a supported install (rc-contract.md section 3.2).
  const tooling = manifests.filter(([, manifest]) => manifest.smthrs?.group === "tooling")
  assert.ok(tooling.length > 0)
  assert.deepEqual(tooling.filter(([, manifest]) => manifest.private !== true).map(([name]) => name), [])
})

test("the packed set is exactly the 40 names the RC contract publishes", () => {
  // rc-contract.md section 3.1 is the release decision; group membership is
  // only how it is enforced. Restating the roster here means a package that
  // joins or leaves the release has to change both files in one diff.
  const manifests = readWorkspaceManifests()
  const packed = workspaces.map((directory) => manifests.get(directory).name)

  assert.equal(publishedPackages.length, 40)
  assert.deepEqual([...packed].sort(), [...publishedPackages].sort())
  assert.ok(publishedPackages.includes("smthrs"), "the unscoped deprecation notice publishes with the RC")
})

test("every packed manifest carries the RC version and the rc dist-tag", () => {
  // A prerelease published to `latest` would upgrade every `smthrs`-adjacent
  // install that tracks the tag, so the tag is pinned per manifest as well as
  // on the publish command (docs/internal/release-runbook.md).
  const manifests = readWorkspaceManifests()
  for (const directory of workspaces) {
    const manifest = manifests.get(directory)
    assert.equal(manifest.version, "1.0.0-rc.0", `${manifest.name} version`)
    assert.equal(manifest.publishConfig.tag, "rc", `${manifest.name} publishConfig.tag`)
    assert.equal(manifest.publishConfig.access, "public", `${manifest.name} publishConfig.access`)
    assert.equal(manifest.publishConfig.provenance, true, `${manifest.name} publishConfig.provenance`)
  }
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

/**
 * Whether an npm `files` entry packs one path. A bare directory packs
 * everything under it; `**` crosses directory boundaries and `*` does not.
 */
const packsPath = (pattern, path) => {
  if (!pattern.includes("*")) return pattern === path || path.startsWith(`${pattern}/`)
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*")
  return new RegExp(`^${source}$`).test(path)
}

test("every published manifest packs the module-type marker its build writes", () => {
  // scripts/build.mjs writes `{"type":"commonjs"}` to dist/cjs/package.json so
  // Node reads the CJS output as CommonJS inside a "type": "module" package. A
  // `files` array whose globs miss that path drops the marker from the tarball
  // while every other package ships it, which is how `smthrs` shipped without
  // it. `dist/**/*` packs it and `dist/**/*.js` does not, so the claim is
  // checked against the path, not against one spelling of the glob.
  const manifests = readWorkspaceManifests()
  const missing = workspaces.filter((directory) =>
    !(manifests.get(directory).files ?? []).some((pattern) => packsPath(pattern, "dist/cjs/package.json"))
  )

  assert.deepEqual(missing, [], "these manifests do not pack dist/cjs/package.json")
})

test("packsPath reads npm files globs the way npm packs them", () => {
  assert.equal(packsPath("dist/**/*", "dist/cjs/package.json"), true)
  assert.equal(packsPath("dist/**/package.json", "dist/cjs/package.json"), true)
  assert.equal(packsPath("dist/**/*.js", "dist/cjs/package.json"), false)
  assert.equal(packsPath("dist/*", "dist/cjs/package.json"), false)
  assert.equal(packsPath("dist", "dist/cjs/package.json"), true)
  assert.equal(packsPath("src/**/*.sql", "src/migrations/0001_memory.sql"), true)
  assert.equal(packsPath("src/**/*.ts", "src/migrations/0001_memory.sql"), false)
})

test("@smthrs/memory packs the SQL reference copies its shipped source cites", () => {
  // The runtime migration is the TypeScript in src/internal/Sql.ts, whose
  // docstring sends a reader to `src/migrations/*.sql`. The tarball ships that
  // source, so it has to ship the files the source names.
  const manifests = readWorkspaceManifests()
  const memory = manifests.get("memory")
  const references = readdirSync(join(repoRoot, "packages", "memory", "src", "migrations"))
    .filter((name) => name.endsWith(".sql"))

  assert.ok(references.length > 0, "the reference copies exist in the tree")
  assert.ok(
    memory.files.includes("src/**/*.sql"),
    `@smthrs/memory files must pack ${references.length} reference migrations`
  )
})

test("the install docs pin the drifted @effect/platform-node-shared to the packed effect version", () => {
  // @effect/platform-node@4.0.0-rc.108 asks for @effect/platform-node-shared
  // ^4.0.0-rc.108, the registry answers 4.0.0-rc.112, and rc.112 peers on
  // effect ^4.0.0-rc.112. A fresh consumer following the install line installs
  // the drifted copy and `npm ls` exits 1. The documented remedy is an
  // overrides pin, and it has to name the version the packed manifests pin.
  const manifests = readWorkspaceManifests()
  const pins = new Set(
    workspaces
      .map((directory) => manifests.get(directory))
      .map((manifest) => manifest.dependencies?.effect ?? manifest.peerDependencies?.effect)
      .filter((range) => typeof range === "string")
  )

  assert.deepEqual([...pins], ["4.0.0-rc.108"], "one effect pin across the published set")
  const pin = [...pins][0]
  for (const relative of ["README.md", join("docs", "pages", "installation.md")]) {
    const source = readFileSync(join(repoRoot, relative), "utf8")
    assert.match(
      source,
      new RegExp(`"@effect/platform-node-shared":\\s*"${pin.replace(/\./g, "\\.")}"`),
      `${relative} must document the overrides pin`
    )
    assert.match(source, /overrides/, `${relative} must name the overrides field`)
  }
})

test("the overrides recipe names the npm ls form that fails and the reinstall it needs", () => {
  // Two measured facts about npm 11.16.0 that the recipe has to carry, or a
  // reader follows it and sees nothing change.
  //
  // Bare `npm ls` prints direct dependencies only. The drifted copy nests
  // below that depth, so the bare form exits 0 with the drift in place; the
  // forms that walk the tree, `npm ls --all` and `npm ls <name>`, are the ones
  // that exit 1. An unqualified "npm ls exits 1" sends a reader to the one
  // command that reports the problem as absent.
  //
  // And npm does not reconcile an installed tree when `overrides` is edited
  // afterward. With `node_modules` and `package-lock.json` on disk, the
  // install answers `up to date` and leaves the drifted copy nested, so the
  // pin only takes effect on a clean install.
  for (const relative of ["README.md", join("docs", "pages", "installation.md")]) {
    const source = readFileSync(join(repoRoot, relative), "utf8")
    assert.match(
      source,
      /npm ls --all/,
      `${relative} must attach the exit-1 claim to a form that walks the tree`
    )
    assert.match(
      source,
      /package-lock\.json/,
      `${relative} must tell an already-installed project to drop its lockfile and reinstall`
    )
    assert.match(
      source,
      /node_modules/,
      `${relative} must tell an already-installed project to drop node_modules and reinstall`
    )
  }
})

test("every published package packs the markdown inside the source tree it ships", () => {
  // The `@smthrs/memory` rule stated once for every package instead of once per
  // file: a package that ships `src/**/*.ts` ships its source as the thing a
  // reader reads, so the prose filed beside that source belongs in the same
  // tarball. `packages/keys/src/README.md` is the file that named the gap.
  const manifests = readWorkspaceManifests()
  const unpacked = []
  for (const directory of workspaces) {
    const source = join(repoRoot, "packages", directory, "src")
    if (!existsSync(source)) continue
    const files = manifests.get(directory).files ?? []
    for (const entry of readdirSync(source, { recursive: true })) {
      const relative = `src/${String(entry).split(sep).join("/")}`
      if (!relative.endsWith(".md")) continue
      if (!files.some((pattern) => packsPath(pattern, relative))) unpacked.push(`${directory}/${relative}`)
    }
  }

  assert.deepEqual(unpacked, [], "these markdown files sit in a packed source tree and no files glob packs them")
})

test("the install line pins @effect/platform-node-shared beside @effect/platform-node", () => {
  // Measured against the live registry on the 40 packed tarballs: a consumer
  // that names @effect/platform-node-shared in its own dependencies resolves
  // one copy at the pinned version under npm 11.16.0, Bun 1.4.0, and pnpm
  // 11.21.0. The five published manifests that already pin it exactly cannot
  // do this for the consumer, because a dependency's manifest does not rewrite
  // the range a sibling declares; only an edge the consumer owns does.
  //
  // The install line is the edge the consumer owns, so the pin belongs there.
  // Without it npm nests @effect/platform-node-shared@4.0.0-rc.112 under
  // @effect/platform-node and `npm ls --all` exits 1.
  const manifests = readWorkspaceManifests()
  const pins = new Set(
    workspaces
      .map((directory) => manifests.get(directory))
      .map((manifest) => manifest.dependencies?.effect ?? manifest.peerDependencies?.effect)
      .filter((range) => typeof range === "string")
  )
  const pin = [...pins][0]

  for (const relative of ["README.md", join("docs", "pages", "installation.md")]) {
    const source = readFileSync(join(repoRoot, relative), "utf8")
    const installLines = source
      .split("\n")
      .filter((line) => /^(pnpm add|npm install|npm i|bun add|yarn add) /.test(line))
      .filter((line) => /@effect\/platform-node@/.test(line))
    assert.ok(installLines.length > 0, `${relative} must show an install command naming @effect/platform-node`)
    const unpinned = installLines.filter(
      (line) => !line.includes(`@effect/platform-node-shared@${pin}`)
    )
    assert.deepEqual(
      unpinned,
      [],
      `${relative} install lines must name @effect/platform-node-shared@${pin} beside @effect/platform-node`
    )
  }
})


test("an export with no require condition is the only thing that exempts a module from the CommonJS check", () => {
  const manifest = {
    publishConfig: {
      exports: {
        "./package.json": "./package.json",
        ".": { types: "./dist/esm/index.d.ts", import: "./dist/esm/index.js", require: "./dist/cjs/index.js" },
        "./Vitest": { types: "./dist/esm/Vitest.d.ts", import: "./dist/esm/Vitest.js" },
        "./*": { types: "./dist/esm/*.d.ts", import: "./dist/esm/*.js" },
        "./internal/*": null
      }
    }
  }
  assert.deepEqual([...esmOnlyModules(manifest)], ["Vitest"])
  assert.deepEqual([...esmOnlyModules({})], [])
  assert.deepEqual([...esmOnlyModules({ publishConfig: { exports: { ".": "./dist/esm/index.js" } } })], [])
})

test("every ESM-only export in the workspace names one concrete module its build program can skip", () => {
  for (const [directory, manifest] of readWorkspaceManifests()) {
    for (const [subpath, conditions] of Object.entries(manifest.publishConfig?.exports ?? {})) {
      if (typeof conditions !== "object" || conditions === null || "require" in conditions) continue
      if (typeof conditions.import !== "string") continue
      assert.equal(
        conditions.import.includes("*"),
        false,
        `${directory} publishes ${subpath} without a require condition through a pattern; the CommonJS check cannot exempt a pattern`
      )
      assert.equal(
        esmOnlyModules(manifest).has(conditions.import.replace(/^\.\/dist\/esm\//, "").replace(/\.js$/, "")),
        true,
        `${directory} publishes ${subpath} import-only but the pack script does not recognise it as ESM-only`
      )
    }
  }
})

test("defaultBindings reports the default import and export sites and nothing spelled inside a string or comment", () => {
  const source = [
    "/**",
    " * import skeleton from \"./Skeleton.ts\"",
    " * export default skeleton",
    " */",
    "import * as Layer from \"effect/Layer\"",
    "import React from \"react\"",
    "import type Shape from \"./Shape.ts\"",
    "import initial from \"./migrations/0001_initial.ts\"",
    "import lineage, { later } from \"../migrations/0002_lineage.ts\"",
    "// import commented from \"./Commented.ts\"",
    "const fence = \"```ts\"",
    "export const template = `\"use server\"",
    "",
    "export default Flow.make({ name: ${JSON.stringify(\"x\")} })",
    "`",
    "export const named = initial",
    "export default named"
  ].join("\n")

  assert.deepEqual(defaultBindings(source), [
    { line: 8, kind: "import", text: "import initial from \"./migrations/0001_initial.ts\"" },
    { line: 9, kind: "import", text: "import lineage, { later } from \"../migrations/0002_lineage.ts\"" },
    { line: 17, kind: "export", text: "export default named" }
  ])
  assert.deepEqual(defaultBindings("export const set = {}\n"), [])
})

test("no published source module default-imports a sibling or exports a default", () => {
  // scripts/build.mjs converts every src file to CommonJS with esbuild
  // (bundle: false) inside a "type": "module" package. For `import x from
  // "./y.ts"` esbuild emits `__toESM(require("./y.js"), 1)` and reads
  // `.default`, which in Node mode is the whole exports object, not the value.
  // `initial.pipe(...)` then threw at module init in the CommonJS entries of
  // @smthrs/control, @smthrs/gateway, and @smthrs/cli while the ESM build was
  // fine, which is how the release smoke found it. The convention that keeps
  // it out is named exports only, and this walk is what holds the convention.
  //
  // The walk covers exactly the packages the RC contract publishes, and only
  // their `src`: legacy/, private workspaces, tests, and docs are never read.
  const manifests = readWorkspaceManifests()
  assert.equal(manifests.size, publishedPackages.length)
  const sites = []
  let modules = 0
  for (const directory of manifests.keys()) {
    const source = join(repoRoot, "packages", directory, "src")
    if (!existsSync(source)) continue
    for (const entry of readdirSync(source, { recursive: true })) {
      const relative = `src/${String(entry).split(sep).join("/")}`
      if (!relative.endsWith(".ts")) continue
      const path = join(source, String(entry))
      if (!statSync(path).isFile()) continue
      modules += 1
      for (const site of defaultBindings(readFileSync(path, "utf8"))) {
        sites.push(`packages/${directory}/${relative}:${site.line}  ${site.text}`)
      }
    }
  }

  assert.ok(modules > 100, `the walk read ${modules} modules, too few to be the published set`)
  assert.deepEqual(
    sites,
    [],
    "these published modules default-import a relative module or declare `export default`, and esbuild's " +
      "CommonJS pass (scripts/build.mjs, bundle: false, in a \"type\": \"module\" package) rewrites such an import " +
      "to `__toESM(require(...), 1).default`, which in Node mode is the whole exports object instead of the " +
      "exported value, so the published CommonJS entry throws at module init; use a named export and a named import"
  )
})
