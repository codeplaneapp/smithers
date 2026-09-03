import { readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Every package's coverage thresholds are its primary regression gate, so the
 * gate itself has to be deterministic. The v8 coverage provider clears its
 * `.tmp` scratch directory at run start and reads it at run end; with the
 * default `./coverage` report directory two concurrent `vitest run`
 * invocations in the same package destroy each other — one aborts with a
 * removed-coverage-directory error and the other enforces 100% against a
 * partial profile with every test passing (issues #115/#121). #115's fix
 * landed in one package only; this conformance test pins the per-process,
 * tmpdir-scoped `reportsDirectory` derivation across ALL packages so a new or
 * regressed config cannot reintroduce the collision.
 *
 * The assertion is on config source text: importing each sibling package's
 * `vitest.config.ts` cross-package would drag in each package's own tsconfig
 * and resolution context, so the deterministic source-level contract is the
 * pinned shape instead — a `reportsDirectory` built from `tmpdir()` and
 * `process.pid`.
 */
describe("vitest coverage isolation conformance", () => {
  // `packages/`, three levels up: this suite lives in `packages/smithers/flows/test`.
  const packagesDir = resolve(import.meta.dirname, "..", "..", "..")
  // The universe is every directory under packages/ that ships a
  // package.json — NOT the directories that already have a vitest config
  // (issue #148): deriving the universe from found configs made a new
  // config-less package invisible to every assertion below, shipping with
  // zero coverage/isolation enforcement while this suite stayed green.
  const isFile = (path: string) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  }
  // One carve-out, named rather than derived: the two private UI kits use
  // `bun test tests` and have no vitest config or publication exports. They
  // remain unpublished, so no public surface escapes the gate.
  //
  // This is a smaller universe, not a smaller assertion: every other package
  // under `packages/` is still derived, so a new config-less package is still
  // visible to every assertion below.
  const zeroXUiKits = new Set(["smithers/ui", "smithers/ui/ui-styleguide"])
  // A third carve-out, for the one nested member that is not a library:
  // `packages/smithers/build/infra` is the hosted cache Cloudflare Worker that ships
  // inside `smithers-build`. It is private, unpublished, and has no
  // publication exports for these cells to describe; it is a workspace member
  // only so its own suite and typecheck run under the root fan-out. It was
  // outside this universe when the derivation read one directory level, and it
  // stays outside now the derivation descends. Every other nested package is a
  // published library and is held to every assertion below.
  const nestedNonLibraries = new Set(["smithers/build/infra"])
  // A fourth carve-out, for the private contract package the two apps share.
  // `@smthrs/rpc` is runtime-free zod schemas and route constants imported by
  // `apps/ui` and `apps/server`; it runs `bun test src` beside its sources,
  // ships no `src/index.ts` barrel and no publication exports, and is never
  // published. It is named rather than derived for the same reason the UI kits
  // are: a smaller universe, not a smaller assertion.
  const bunTestedContracts = new Set(["rpc"])
  // The universe descends. A granular package can sit inside the product
  // package it belongs to — `packages/smithers/flows/canonical` is `@smthrs/canonical`
  // — and a derivation that read one directory level would drop it from every
  // assertion below the day it moved, which is #148 again by another route.
  // Each cell names a package by its path under `packages/`, so a nested
  // package answers for itself instead of borrowing its parent's row.
  const packagesUnder = (parent: string): ReadonlyArray<string> =>
    readdirSync(join(packagesDir, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .flatMap((entry) => {
        const name = parent === "" ? entry.name : `${parent}/${entry.name}`
        return isFile(join(packagesDir, name, "package.json")) ? [name, ...packagesUnder(name)] : []
      })
  const packages = packagesUnder("")
    .filter((name) => !zeroXUiKits.has(name))
    .filter((name) => !nestedNonLibraries.has(name))
    .filter((name) => !bunTestedContracts.has(name))
  const configs = packages.map((name) => {
    const path = join(packagesDir, name, "vitest.config.ts")
    return {
      name,
      path,
      source: isFile(path) ? readFileSync(path, "utf8") : ""
    }
  })

  it("finds every package's vitest config", () => {
    const names = configs.map((config) => config.name)
    expect(names).toContain("smithers/flows")
    expect(names).toContain("smithers/flows/kernel")
    expect(names.length).toBeGreaterThanOrEqual(11)
  })

  it.each(configs)("$name ships a vitest config at all (issue #148)", ({ path, source }) => {
    // An empty source means the package exists but has no config file —
    // the exact omission the config-derived universe could never see.
    expect(source, `${path} is missing`).not.toBe("")
  })

  // A second named carve-out, and only from the export-shape cell below. The
  // unscoped `smthrs` package is a migration notice whose single module throws
  // on import and exposes only `.`. It still ships a vitest config, `scripts.test`, and the
  // 100% coverage gate, so it is inside every other assertion in this suite.
  const noticeOnlyPackages = new Set(["smthrs-deprecation"])

  it.each(packages.map((name) => ({ name })))(
    "$name retains Effect-style source exports and declares built publication exports",
    ({ name }) => {
      const manifest = JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8")) as {
        readonly private?: boolean
        readonly smthrs?: { readonly group?: string }
        readonly exports?: Record<string, string>
        readonly publishConfig?: {
          readonly exports?: Record<string, string | Record<string, string>>
        }
      }
      expect(manifest.exports?.["."]).toBe("./src/index.ts")
      if (noticeOnlyPackages.has(name)) {
        expect(manifest.exports?.["./*"]).toBeUndefined()
        expect(manifest.publishConfig?.exports?.["."]).toEqual({
          types: "./dist/esm/index.d.ts",
          import: "./dist/esm/index.js",
          require: "./dist/cjs/index.js"
        })
        return
      }
      expect(manifest.exports?.["./*"]).toBe("./src/*.ts")
      // A third carve-out, derived rather than named, and only from the
      // publication half of this cell. `scripts/pack-release.mjs:43` skips a
      // manifest that is `private` or outside the `engine` and `agent`
      // release groups, so the build graph, its CLI, and the target library —
      // private, `smthrs.group: "tooling"`, packed by no candidate — have no
      // published surface for a `publishConfig.exports` map to describe.
      // The exemption is conditioned on the two facts that make it
      // true, so it expires by itself: a package that drops `private`, or
      // moves into a release group, falls straight back into the assertion
      // below. Every other private package here (`chain`, `evals`, `fs`,
      // `scorers`, `triggers`, `integrations`, `errors`, `create-app`) is in
      // a release group, kept the map it arrived with, and is still held to
      // its exact shape, so nothing that could be packed reaches this branch.
      const publication = manifest.publishConfig?.exports
      if (publication === undefined && manifest.private === true) {
        expect(
          manifest.smthrs?.group,
          `packages/${name} declares no publishConfig.exports; only the private tooling group may omit one`
        ).toBe("tooling")
        return
      }
      for (const subpath of [".", "./*"] as const) {
        const target = publication?.[subpath]
        expect(target).toEqual({
          types: subpath === "." ? "./dist/esm/index.d.ts" : "./dist/esm/*.d.ts",
          import: subpath === "." ? "./dist/esm/index.js" : "./dist/esm/*.js",
          require: subpath === "." ? "./dist/cjs/index.js" : "./dist/cjs/*.js"
        })
      }
    }
  )

  it.each(configs)(
    "$name scopes its coverage report directory to tmpdir() and process.pid",
    ({ name, source }) => {
      // The report directory must be derived per process and live outside the
      // package working tree: `join(tmpdir(), \`flows-<pkg>-coverage-${pid}\`)`.
      expect(source).toMatch(
        /reportsDirectory:\s*join\(\s*tmpdir\(\),\s*`flows-[a-z-]+-coverage-\$\{process\.pid\}`\s*\)/
      )
      // The derivation only isolates if the real node:os/node:path helpers
      // are in scope.
      expect(source).toContain(`import { tmpdir } from "node:os"`)
      expect(source).toContain(`import { join } from "node:path"`)
      // The slug is the package's own directory name. A nested package
      // (`flows/canonical`) is named by its path here, and a report directory
      // is one path segment.
      expect(source).toContain(`flows-${name.slice(name.lastIndexOf("/") + 1)}-coverage`)
    }
  )

  // No package currently lacks an enabled coverage gate. Keep this explicit
  // set and its inverted assertion so any future temporary deferral remains
  // narrow, reviewable, and self-expiring when the package enables its gate.
  const coverageGateDeferred = new Set<string>()

  // These packages were migrated wholesale from the former agent and smithers build
  // repositories. They already enforce honest measured floors, but did not
  // arrive with complete branch coverage. Treating those floors as if they
  // were 100% made this conformance suite red while every package-local gate
  // was green; simply writing `100` into the configs would make the root gate
  // unusable.
  // The set is explicit and self-expiring: every member must retain a real,
  // non-zero threshold in all four categories and at least one category below
  // 100. Once a package reaches full coverage it must leave this set.
  // `integrations` joins them for the same reason: it was imported wholesale;
  // its floors (branches 94, functions 98, lines
  // 99, statements 98) are the measured coverage of adapters that talk to
  // GitHub, Linear, and Telegram over HTTP, and its own config carries the
  // instruction to raise them as each case closes.
  // `migrate` joins them too: its floors are 70 in all four categories, the
  // measured coverage of a translator whose remaining branches are the 0.x
  // shapes only a live model run reaches, and those three cases are pinned in
  // `scripts/test-pins.md` rather than run by the default gate.
  // `control` and `testing` left the set on 2026-09-01: both now pin 100 in
  // every category (`6b3e0142e4`, `d1012596b6`).
  const coverageFloorDeferred = new Set([
    "smithers",
    "smithers/agent/memory",
    "smithers/agent/registry",
    "smithers/agent/std",
    "smithers/build",
    "smithers/build/build-cli",
    "smithers/build/targets",
    "smithers/agent/integrations",
    "smithers/migrate"
  ])

  /**
   * The block a `key: {` opens, or null when the source has no such block or
   * an unbalanced one.
   */
  const block = (source: string, key: string): string | null => {
    // Anchored on the key followed by its brace. `indexOf("coverage:")` finds
    // the word inside the comment that explains why the fault tier runs
    // "without coverage:", and the block read from there is whatever brace
    // happens to come next.
    const at = source.search(new RegExp(`\\b${key}\\s*\\{`))
    if (at === -1) return null
    const open = source.indexOf("{", at)
    if (open === -1) return null
    let depth = 0
    for (let index = open; index < source.length; index++) {
      if (source[index] === "{") depth++
      else if (source[index] === "}") {
        depth--
        if (depth === 0) return source.slice(open + 1, index)
      }
    }
    return null
  }

  /**
   * The package one coverage exclusion names, or null when it names none.
   *
   * An exclusion inside the coverage block normally shrinks the production
   * denominator, which is the defect this suite exists to stop. There is one
   * shape that does the opposite: a pattern naming ANOTHER package's tree
   * removes code this package's gate was never responsible for. Two spellings
   * reach one — `<child>/**` for a package nested inside this one, and
   * `**\/<path>/**` for a package elsewhere under `packages/` — and both are
   * resolved here against a real `package.json`, so the exemption expires the
   * day that package moves or stops existing and can never be spelled to hide
   * this package's own source.
   */
  const excludedPackage = (name: string, pattern: string): string | null => {
    const body = pattern.replace(/^\*\*\//, "").replace(/\/\*\*$/, "")
    if (body === "" || body.includes("*")) return null
    for (const candidate of [`${name}/${body}`, body]) {
      if (candidate !== name && isFile(join(packagesDir, candidate, "package.json"))) return candidate
    }
    return null
  }

  const assertCoverageDenominator = (name: string, source: string) => {
    expect(source).toMatch(/coverage:\s*\{[^]*?enabled:\s*true/)
    expect(source).toMatch(/include:\s*\[\s*"src\/\*\*(?:\/\*\.ts)?"\s*\]/)
    expect(source).toMatch(/provider:\s*"v8"/)
    // A test-runner `test.exclude` is legitimate (for example fixture source
    // that is not a test). An exclusion inside the coverage block shrinks the
    // production denominator, with one exception that does the opposite: a
    // nested package's directory. The v8 provider reports every file EXECUTED
    // under the vitest root whatever `include` says, so an enclosing package
    // that imports its nested one would otherwise measure that package's code
    // against ITS OWN gate — code the enclosing suite never covers and the
    // nested suite already covers to 100%. Only a `<dir>/**` naming a real
    // nested package is allowed, so the exemption expires with the nesting and
    // can never be spelled to hide this package's own source.
    const coverage = block(source, "coverage") ?? ""
    const excluded = [
      ...(/\bexclude\s*:\s*\[([^\]]*)\]/.exec(coverage)?.[1] ?? "").matchAll(/"([^"]+)"/g)
    ].flatMap((match) => match[1] === undefined ? [] : [match[1]])
    expect(
      coverage === "" || !/\bexclude\s*:/.test(coverage) || excluded.length > 0,
      `packages/${name}/vitest.config.ts declares a coverage exclusion this cell cannot read`
    ).toBe(true)
    expect(
      excluded.filter((entry) => excludedPackage(name, entry) === null),
      `packages/${name}/vitest.config.ts carries a coverage exclusion that names no other package; ` +
        "an exclusion may only remove another package's tree, never this package's own production source"
    ).toEqual([])
    expect(source).not.toMatch(/\bautoUpdate\s*:/)
    expect(source).not.toMatch(/\ball\s*:/)
    expect(source).not.toMatch(/\bextension\s*:/)
    expect(source).not.toMatch(/\bignoreClassMethods\s*:/)
  }

  /**
   * The aggregate categories inside a `thresholds` block, with any per-file
   * entries removed.
   *
   * A package on the floor list may pin per-file floors beside its aggregate
   * ones, which is the opposite of the #147 hazard: under a 100% gate a
   * per-file key REMOVES its file from the global check, but under a measured
   * floor it adds a second, tighter gate over the modules an aggregate
   * dominated by well-covered code would otherwise hide. `@smthrs/build-cli`
   * pins nine such files over the process-spawning and publishing backends.
   * A `[^{}]*` capture cannot see past the first nested object, so it matched
   * nothing at all there and the cell read as "no thresholds declared". Brace
   * matching the block and then dropping the nested objects leaves exactly
   * the aggregate categories this cell is about. The 100% cell below keeps
   * its flat-only rule, where nesting really is the defect.
   */
  const aggregateThresholds = (source: string): string | null => {
    const key = source.indexOf("thresholds:")
    if (key === -1) return null
    const open = source.indexOf("{", key)
    if (open === -1) return null
    let depth = 0
    for (let index = open; index < source.length; index++) {
      if (source[index] === "{") depth++
      else if (source[index] === "}") {
        depth--
        if (depth > 0) continue
        let body = source.slice(open + 1, index)
        // Innermost-first, repeated until the body stops changing, so a
        // per-file entry that itself nested would still be removed whole.
        while (/\{[^{}]*\}/.test(body)) body = body.replace(/\{[^{}]*\}/g, "")
        return body
      }
    }
    // An unbalanced block is a malformed config, reported as an absent one.
    return null
  }

  it("pins the coverage-gate deferral set to packages that really exist", () => {
    // Guard the deferral the way every other exclusion here is guarded: a
    // renamed or removed package must fail here, not silently widen the set.
    const names = configs.map((config) => config.name)
    for (const name of [...coverageGateDeferred, ...coverageFloorDeferred]) {
      expect(names, `${name} is in the deferral set but not in packages/`).toContain(name)
    }
    expect([...coverageGateDeferred].filter((name) => coverageFloorDeferred.has(name))).toEqual([])
  })

  it.each(configs.filter((config) => coverageGateDeferred.has(config.name)))(
    "$name has NOT yet enabled the 100% coverage gate (deferred, remove from the set once it does)",
    ({ source }) => {
      expect(source).not.toMatch(/coverage:\s*\{[^]*?enabled:\s*true/)
    }
  )

  it.each(configs.filter((config) => coverageFloorDeferred.has(config.name)))(
    "$name enforces an honest measured coverage floor over all of src/**",
    ({ name, source }) => {
      assertCoverageDenominator(name, source)
      const pinned = aggregateThresholds(source)
      expect(pinned, `packages/${name}/vitest.config.ts declares no thresholds block`).not.toBeNull()
      const values = [...(pinned ?? "").matchAll(/\b(branches|functions|lines|statements):\s*(\d+)/g)]
      expect(values.map((match) => match[1]).sort()).toEqual(["branches", "functions", "lines", "statements"])
      const numbers = values.map((match) => Number(match[2]))
      expect(numbers.every((value) => value > 0 && value <= 100)).toBe(true)
      expect(numbers.some((value) => value < 100)).toBe(true)
    }
  )

  it.each(
    configs.filter((config) => !coverageGateDeferred.has(config.name) && !coverageFloorDeferred.has(config.name))
  )(
    "$name enforces 100% coverage over src/** on every run (issue #137)",
    ({ name, source }) => {
      // The thresholds are the primary regression gate, so the gate itself
      // is pinned cross-package: a sibling that drops `enabled: true`,
      // lowers a threshold, or narrows `include` must fail HERE, not go
      // silently un-enforced with its own suite green.
      assertCoverageDenominator(name, source)
      // Both shipped shapes cover every production module: `src/**` and the
      // equivalent `src/**/*.ts`.
      // The thresholds object must be FLAT (issue #147): `[^{}]*` refuses a
      // nested object, because vitest's v8 provider treats a glob key
      // (`"src/risky.ts": { lines: 0 }`) as a per-file override that removes
      // matching files from the global 100% check. The earlier `[^}]*`
      // capture stopped at the nested object's first `}` yet still contained
      // all four pinned categories, so such an override slipped the gate.
      const thresholds = source.match(/thresholds:\s*\{([^{}]*)\}/)
      expect(thresholds).not.toBeNull()
      // The capture group always exists when the match does; `?? ""` only
      // satisfies `noUncheckedIndexedAccess`, and an empty body would fail
      // every category assertion below anyway.
      const pinned = thresholds?.[1] ?? ""
      for (const category of ["branches", "functions", "lines", "statements"]) {
        expect(pinned).toMatch(new RegExp(`${category}:\\s*100(?:\\s*,|\\s*\\})?`))
      }
      // And it must contain NOTHING BUT the four pinned categories: any
      // leftover key — a glob override without a nested object, a fifth
      // category at another value — must be widened here in review, never
      // added silently.
      const leftover = pinned.replace(/\b(?:branches|functions|lines|statements):\s*100\s*,?/g, "").trim()
      expect(leftover).toBe("")
      // The gate can also be weakened without touching any pinned field
      // (issue #142): `coverage.exclude` is applied ON TOP of `include`, so
      // one entry removes arbitrary src files from the 100% denominator
      // while every assertion above still passes, and
      // `thresholds.autoUpdate` rewrites the pinned 100s downward on a red
      // run. No shipped config carries either; a package that needs an
      // exclusion must widen this conformance test in review, not add it
      // silently.
      // `coverage.all: false` and a narrowed `coverage.extension` list are
      // the same silent-denominator-shrinking mechanism (issue #152): the
      // v8 provider defaults `all: true`, so every src file no test loads
      // still counts against the 100% thresholds; `all: false` (or an
      // extension list that drops files) restricts the check to files tests
      // happen to load while every pinned assertion above stays green.
      // The provider itself must be pinned to "v8" (issue #157): the whole
      // ignore-directive inventory below is written against the v8 provider's
      // hint grammar, and a silent flip to `provider: "istanbul"` would
      // activate `istanbul ignore` comments under a different parser while
      // every assertion above stays green.
      // `coverage.ignoreClassMethods` subtracts every method with a matching
      // name from the denominator with no per-site comment to inventory —
      // forbid it outright (issue #157).
    }
  )

  it.each(packages.map((name) => ({ name })))(
    "$name pins the test script CI actually invokes (issue #158)",
    ({ name }) => {
      // CI runs the root `pnpm test`, which recursively runs every workspace's
      // test script: a package that deletes or stubs its `scripts.test` is
      // silently never run while every config-level assertion above stays
      // green. The script CI invokes is therefore pinned here to the exact
      // canonical value every package ships — plain `vitest`, whose default
      // command in non-interactive CI is a single run with the package's own
      // config (and its 100% coverage gate) applied.
      const manifest = JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8")) as {
        readonly scripts?: Record<string, string>
      }
      expect(manifest.scripts?.test, `packages/${name}/package.json scripts.test`).toBe("vitest")
    }
  )

  it("pins the root workspaces globs to the conformance universe (issue #154)", () => {
    // The universe above is derived from `packages/`; that is complete only
    // while `packages/*` is the WHOLE workspace. A second glob (`apps/*`)
    // would ship its packages with no coverage gate at all while every cell
    // here stayed green — the #148 defect reinstated silently. Adding a
    // workspace root means widening this assertion AND the universe
    // derivation above, in review.
    //
    // Widened once, deliberately: `examples` is a private, unpublished
    // workspace of runnable documentation programs. It ships no `src` tree
    // and no coverage gate, and the universe derivation above still reads
    // `packages/` only, so it adds no ungated publishable surface. It is a
    // workspace so its end-to-end suite resolves the real `@smthrs/*`
    // packages and runs under the root `pnpm test` fan-out.
    // Widened a second time, deliberately (2026-08-15, smithers build absorption):
    // `packages/smithers/build/infra` is the hosted cache Cloudflare Worker that ships
    // inside the `smithers-build` package. It is private and unpublished, and it is a
    // workspace member only so its own vitest suite and `tsc --noEmit` run under
    // the root fan-out instead of being dead code. It is NESTED under
    // `packages/smithers/build`, so the `packages/` universe derivation above — which
    // reads top-level directories only — is unaffected and no top-level
    // publishable surface escapes the gate. `sharp` and `workerd` are its
    // wrangler toolchain's postinstall builds, denied like every other.
    // Narrowed again: `e2e` was the fault-injection matrix, widened into this
    // roster by release gate B6 because it was not a member, had no
    // `node_modules`, and `//e2e:faults` failed in 262 ms with
    // `Command "vitest" not found` — eighteen crash, restart, gateway,
    // time-travel, provider, and safety cases that had never run under any
    // gate. Membership is not what a case needs any more: every one of them
    // now lives in the package whose behaviour it asserts, under
    // `test/faults`, where the package's own `node_modules`, `check`, and
    // `faults` target already reach it. `//packages/...:faults` is the matrix.
    // Widened a third time for the deployable applications. `apps/*` contains
    // private entry points rather than published library packages; each app's
    // own test/build scripts participate in the root recursive gates, while
    // the package publication/coverage universe remains `packages/*`.
    // Widened a fifth time: `evals/*` are the evaluation suites. Each one now
    // carries its own private manifest and pins its own `typescript` and
    // `@types/node` instead of resolving whatever the root install hoisted.
    // They are private, unpublished, ship no `src` tree, and sit outside the
    // `packages/` universe derivation above, so they add no ungated
    // publishable surface.
    //
    // Widened a sixth time, and this one adds no surface: `packages/smithers/flows/canonical`
    // is `@smthrs/canonical` nested inside the product package it belongs to, so
    // the hierarchy is visible in the tree. It publishes the same name at the same
    // version to the same dist-tag, and the universe derivation above descends, so
    // it is still held to every assertion here. Membership is spelled out rather
    // than widened to `packages/*/*`: that glob names directories that are not
    // packages, and the gates that read this list one directory deep would stop
    // covering nested members without failing.
    const workspace = readFileSync(join(packagesDir, "..", "pnpm-workspace.yaml"), "utf8")
    const packagesBlock = workspace.match(/^packages:\n(?:  - .+\n)+/m)?.[0]
    expect(packagesBlock).toBe(
      [
        "packages:",
        "  - \"packages/*\"",
        "  - \"packages/smithers/*\"",
        "  - \"packages/smithers/agent/*\"",
        "  - \"packages/smithers/build/*\"",
        "  - \"packages/smithers/flows/*\"",
        "  - \"packages/smithers/ui/*\"",
        "  - \"examples\"",
        "  - \"apps/*\"",
        "  - \"evals/*\"",
        ""
      ].join("\n")
    )

    // The allowBuilds roster is a supply-chain control, not formatting: each
    // entry denies a dependency's postinstall build, and `playwright` is the
    // clearest case — its postinstall downloads browsers, while the live-*
    // checks run against an already-installed one. Denying a build removes
    // ungated surface rather than adding it.
    //
    // This block is asserted on its own rather than as part of an exact match
    // over the whole file. Pinning the entire file made every unrelated
    // addition (`minimumReleaseAgeExclude`, for one) look like a failure here,
    // which is what pressured an earlier change into dropping the roster from
    // the assertion altogether. Flipping any entry to `true` must fail a gate.
    const allowBuilds = workspace.match(/^allowBuilds:\n(?:  .+\n)+/m)?.[0]
    expect(allowBuilds).toBe(
      [
        "allowBuilds:",
        "  \"@journeyapps/wa-sqlite\": false",
        "  dprint: false",
        "  es5-ext: false",
        "  esbuild: false",
        "  msgpackr-extract: false",
        "  playwright: false",
        "  sharp: false",
        "  unrs-resolver: false",
        "  vue-demi: false",
        "  workerd: false",
        ""
      ].join("\n")
    )
    expect(workspace).toMatch(/^linkWorkspacePackages: true$/m)
    expect(workspace).toMatch(/^verifyDepsBeforeRun: false$/m)
  })

  it("pins the root aggregator scripts CI invokes (issue #166)", () => {
    // The per-package `scripts.test` pin (issue #158) covered the leaves but
    // not the root: CI runs `pnpm test`, and the root aggregator is what fans
    // that out across every workspace. Narrowing it — e.g. to
    // `--workspace packages/smithers/flows` — silently dropped siblings from CI while
    // every per-package cell and the workspaces-glob cell stayed green. The
    // exact aggregator bodies are pinned here; changing how CI fans out
    // means widening this assertion in review.
    //
    // `test:examples` is a named alias for the examples workspace only. The
    // root `test` fan-out already reaches it, so the alias is a documentation
    // entry point rather than a second enforcement path.
    //
    // `deploy:dry` is the same shape: a single-workspace alias for the server
    // app's deploy rehearsal. It is not a gate CI fans out, so it neither adds
    // nor removes enforcement — it is pinned only so the roster stays exact.
    //
    // `dev` is a developer entry point, not a gate: it forwards to the UI
    // workspace's `start` (devkit projection, `vite build --configLoader
    // runner`, `electrobun dev`) so the Electrobun launch lives in one place.
    // The web-era `checklist` forwarder left with the web scripts it entered
    // (local-app wave 1). `dev` runs nothing in CI and fans nothing out.
    //
    // `test:jsdoc` is the root-level contract for the repository's custom
    // JSDoc rule harness; pinning it here keeps that non-workspace gate from
    // appearing or disappearing without conformance review.
    //
    // `test:e2e` is the macOS developer entry point for the packaged
    // Electrobun lane. It builds a stable bundle and drives that bundle with
    // Bun; CI does not invoke it because the package graph has no macOS host.
    //
    // `check:npm-dedupe` is the operator alias for `//scripts:npmDedupe`, the
    // same shape as `browser` and `//scripts:browserContract`. The resolution reads
    // registry metadata, so the target is uncacheable and re-runs regardless,
    // which is the only concession the network costs. The alias is pinned so
    // the roster stays exact, not because it is a second enforcement path.
    const root = JSON.parse(readFileSync(join(packagesDir, "..", "package.json"), "utf8")) as {
      readonly scripts?: Record<string, string>
    }
    expect(root.scripts).toEqual({
      browser: "node scripts/browser-check.mjs",
      check: "pnpm --recursive --if-present run check",
      "check:npm-dedupe": "node scripts/check-npm-dedupe.mjs",
      circular: "pnpm --recursive --if-present run circular",
      "deploy:dry": "pnpm --filter smithers-server run deploy:dry",
      dev: "pnpm --filter smithers-ui run start",
      lint: "pnpm --recursive --if-present run lint",
      test: "pnpm --recursive --if-present run test",
      "test:e2e": "bun apps/ui/e2e/packaged/run.ts",
      "test:examples": "pnpm --filter @smthrs/examples run test",
      "test:jsdoc": "node --test eslint.jsdoc.test.mjs"
    })
  })

  it("pins the CI steps that reach the target graph and the jj install (issue #166)", () => {
    // The yml is the last unpinned hop: a step that stops running the package
    // graph (or drops the jj install the real-binary host suite requires, issue
    // #163) skips enforcement with every conformance cell green. Source-text
    // pins, matching the config-source approach used across this suite.
    //
    // The gates used to be `pnpm run check`, `pnpm run lint`, `pnpm run
    // circular`, `pnpm run browser`, and `pnpm test` — five recursive scripts
    // named as raw strings in PACKAGE.ts. They are targets now, so what is pinned
    // is the verb-and-pattern invocation that plans them: `smithers-build ci` over the
    // package graph covers lib, check, test, lint, fmt, docs, and circular for
    // every package, and the browser contract is its own labelled target.
    const ci = readFileSync(join(packagesDir, "..", ".github", "workflows", "ci.yml"), "utf8")
    expect(ci).toMatch(/^\s*- uses: pnpm\/action-setup@v6$/m)
    expect(ci).toMatch(/^\s*- run: pnpm install --frozen-lockfile --ignore-scripts$/m)
    expect(ci).toMatch(/^\s*run: pnpm exec smithers-build ci '\/\/packages\/\.\.\.'/m)
    expect(ci).toMatch(/^\s*run: pnpm exec smithers-build test '\/\/scripts\/\.\.\.'$/m)
    // Browser support is a hard requirement met through layers; the browser
    // contract target is the only thing that proves it, so CI has to run it
    // (REVIEW.md blocker 7).
    expect(ci).toMatch(/^\s*run: pnpm exec smithers-build test '\/\/scripts:browserContract'$/m)
    expect(ci).toMatch(/^\s*run: pnpm exec smithers-build test '\/\/packages\/\.\.\.'$/m)
    // The Bun compatibility matrix. It used to be `//ci/...`, a directory whose
    // only content was one Vitest target per package, declared from outside the
    // package it re-ran, and then a dedicated `bun` job running
    // `//packages/...:bunTest`. Both are gone: a `bunTest` is a `test`-kind
    // target inside its own package, so the two pins above --
    // `ci '//packages/...'` and `test '//packages/...'` -- already plan every
    // Bun suite. What has to stay pinned is that those two jobs install Bun,
    // because dropping the runtime from either toolchain would make the suites
    // fail to run rather than silently skip.
    expect(ci).not.toContain("//ci/...")
    const bunSetup = ci.split(/^  (?=\S)/m).filter((job) => job.includes("oven-sh/setup-bun@v2"))
    expect(bunSetup.length).toBeGreaterThanOrEqual(2)
    expect(bunSetup.some((job) => job.startsWith("test:"))).toBe(true)
    expect(bunSetup.some((job) => job.startsWith("packages:"))).toBe(true)
    // The fault matrix. Until release gate B6 it ran under no gate at all:
    // `//packages/...` did not reach `e2e/`, `e2e` was not a workspace member,
    // and `//e2e:faults` failed in 262 ms with `Command "vitest" not found`.
    // There is no `e2e/` any more: each case lives in the package it asserts
    // about and `//packages/...:faults` selects every one of them, so the
    // separate typecheck step is gone too — the `ci '//packages/...'` pin above
    // covers it, because each package's `check` reads its own `test/**`.
    // `--jobs 1` is part of the contract rather than a throughput choice: two
    // packages' fault suites cannot share a machine any more than two files
    // inside one of them can. The job is required now that the redaction
    // deliverable landed: case 22's terminal-log half was the one gate red by
    // design, the redacting logger closed it, and the matrix is 67 of 67.
    expect(ci).not.toContain("//e2e:")
    expect(ci).toMatch(/^\s*run: pnpm exec smithers-build test '\/\/packages\/\.\.\.:faults' --jobs 1$/m)
    // And it gates. `continue-on-error: true` is the single line that makes a
    // lane advisory, so a matrix that runs but cannot fail the pipeline is
    // exactly the state this deliverable left behind, and it would read as
    // green from every other pin in this file. Slice the job out by its own
    // key rather than searching the whole document, because two other lanes
    // legitimately carry the line.
    const faultsJob = ci.slice(ci.indexOf("\n  e2e-faults:") + 1).split(/\n {2}(?=\S)/)[0]!
    expect(faultsJob).toContain("//packages/...:faults")
    expect(faultsJob).not.toContain("continue-on-error")
    expect(ci).toMatch(/tool: jj-cli@\d+\.\d+\.\d+/)
    expect(ci).toMatch(/^\s*run: jj git init --colocate$/m)
  })

  it("runs the package suites on every platform as one matrix, with the advisory bit as data", () => {
    // The package suites used to be a required ubuntu job plus two
    // copy-pasted advisory jobs, `node-macos` and `node-windows`, free to
    // drift into running different steps. One matrix runs the same step
    // everywhere. What is pinned is the shape that makes a platform's status
    // legible without an `if:` key: the platform list, one `include:` row per
    // platform carrying its own advisory bit, and a `continue-on-error` that
    // reads that bit rather than excusing every row at once.
    //
    // macOS and Windows are advisory ONLY until the matrix proves them green.
    // Promoting one flips its boolean in PACKAGE.ts and moves the `advisory:
    // true` line below; leaving a promoted platform advisory here is the drift
    // this cell exists to force into review.
    const ci = readFileSync(join(packagesDir, "..", ".github", "workflows", "ci.yml"), "utf8")
    expect(ci).toContain(
      `  packages:
    name: "package suites (\${{ matrix.os }})"
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        include:
          - os: ubuntu-latest
            advisory: false
          - os: macos-latest
            advisory: true
          - os: windows-latest
            advisory: true
    runs-on: \${{ matrix.os }}
    timeout-minutes: 60
    continue-on-error: \${{ matrix.advisory }}
`
    )
    // One rendering of the step, shared by every platform.
    expect(ci.split("run: pnpm exec smithers-build test '//packages/...'").length - 1).toBe(1)
    // The lanes the matrix replaced are gone, not renamed alongside it.
    expect(ci).not.toContain("node-macos")
    expect(ci).not.toContain("node-windows")
    // A red platform must not cancel the platforms still running: the matrix
    // exists to answer which platforms are green.
    expect(ci).toMatch(/^ {6}fail-fast: false$/m)
  })

  it("keeps every CI step a target invocation, never a hand-written command", () => {
    // The rule this pins: a PACKAGE.ts file declares targets, and the argv a
    // target runs is rendered inside its implementation. A `run:` line in the
    // generated workflow that is not a target invocation, an install, or a
    // toolchain step derived from a declaration would mean someone reopened the
    // free-form step surface that `GithubCiGen` deleted.
    const ci = readFileSync(join(packagesDir, "..", ".github", "workflows", "ci.yml"), "utf8")
    const commands = [...ci.matchAll(/^\s*(?:- )?run: (?!\|)(.+)$/gm)].map((match) => match[1]!)
    expect(commands.length).toBeGreaterThan(0)
    const derived = [
      /^pnpm exec smithers-build (?:build|test|lint|docs|review|ci) '\/\/[^']*'( --jobs \d+)?$/,
      /^pnpm install --frozen-lockfile --ignore-scripts$/,
      /^rustup toolchain install$/,
      /^jj git init --colocate$/
    ]
    expect(commands.filter((command) => !derived.some((shape) => shape.test(command)))).toEqual([])
    // No recursive pnpm script survives as a gate: those are what the target
    // graph replaced.
    expect(ci).not.toMatch(/^\s*run: pnpm run /m)
    expect(ci).not.toMatch(/^\s*run: node --test /m)
  })

  it("smoke-validates packed artifacts before rerunnable publication", () => {
    const release = readFileSync(join(packagesDir, "..", ".github", "workflows", "release.yml"), "utf8")
    const smoke = release.indexOf("Pack and smoke-test release artifacts")
    const publish = release.indexOf("Publish packages in dependency order")
    expect(smoke).toBeGreaterThan(-1)
    expect(publish).toBeGreaterThan(smoke)
    expect(release).toContain("node scripts/pack-release.mjs \"$PACK_DIR\"")
    expect(release).toContain("node scripts/smoke-release.mjs \"$PACK_DIR\"")
    // Both workflows install the pnpm version pinned once in package.json.
    const root = JSON.parse(readFileSync(join(packagesDir, "..", "package.json"), "utf8")) as {
      readonly packageManager?: string
    }
    expect(root.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/)
    expect(release).toMatch(/^\s*- uses: pnpm\/action-setup@v6$/m)
    const ci = readFileSync(join(packagesDir, "..", ".github", "workflows", "ci.yml"), "utf8")
    expect(ci).toMatch(/^\s*- uses: pnpm\/action-setup@v6$/m)
    expect(release).toContain("pnpm publish \"$PACK_DIR/$tarball\"")
    expect(release).toContain("pnpm view \"$spec\" version")
    // The published set and its order are read out of the pack manifest, so a
    // restated package list cannot drift from what was packed. `scripts/
    // pack-release.test.mjs` holds the rest of that conformance suite.
    expect(release).toContain("manifest.json")
    expect(release).not.toContain("publish_if_missing")
    const packScript = readFileSync(join(packagesDir, "..", "scripts", "pack-release.mjs"), "utf8")
    const smokeScript = readFileSync(join(packagesDir, "..", "scripts", "smoke-release.mjs"), "utf8")
    expect(packScript).toContain("publicationManifest(manifest)")
    expect(packScript).toContain("\"pnpm\",")
    expect(packScript).toContain("\"pack\"")
    expect(smokeScript).toContain("\"pnpm\",")
    expect(smokeScript).toContain("\"add\"")
    expect(smokeScript).toContain("for (const entry of packManifest)")
    expect(smokeScript).toContain("await import(${JSON.stringify(entry.name)})")
    expect(smokeScript).toContain("require(${JSON.stringify(entry.name)})")
    // Validation after publish cannot protect the release that was just
    // exposed. The smoke check and publication live in the same gated job.
    expect(release).not.toMatch(/^\s+smoke:\s*$/m)
  })

  it("pins the CI triggers and forbids step conditions on enforcement (issue #176)", () => {
    // The #166 pins cover the run commands but not the two cheapest silent
    // disables: deleting `pull_request:` from the `on:` block (CI stops
    // gating PRs while every run-line regex still matches), or adding an
    // `if:` condition to a named step (its separate `run:` line matches
    // verbatim regardless). Pin the trigger block exactly, and assert the
    // workflow contains no `if:` key at all — any conditional execution of
    // an enforcement step must widen this cell in review.
    const ci = readFileSync(join(packagesDir, "..", ".github", "workflows", "ci.yml"), "utf8")
    expect(ci).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:$/m)
    expect(ci).not.toMatch(/^\s*if:/m)
  })

  it("inventories every coverage-ignore directive against a pinned allowlist (issues #153/#157)", () => {
    // An ignore hint is subtracted from the denominator BEFORE the 100%
    // thresholds are evaluated, so a one-line comment is the cheapest way to
    // ship an uncovered branch with zero test failures. Every directive in
    // any package's src tree must appear here, with its count: adding one —
    // or moving one — means widening this allowlist in review, with the
    // justification the diff forces into the open.
    //
    // The inventory matches the provider's FULL hint grammar (issue #157):
    // the v8 provider parses hints via ast-v8-to-istanbul, whose regex is
    // /^\s*(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(if|else|next|file)(?=\W|$)/
    // plus a start/stop range variant — so `c8 ignore next`,
    // `istanbul ignore else`, and `node:coverage ignore file` are all live
    // directives that the earlier literal-`v8 ignore` grep never saw.
    const directive = /(?:istanbul|[cv]8|node:coverage)\s+ignore\s+(if|else|next|file|start|stop)(?=\W|$)/g
    const allowlist: Record<string, number> = {
      // `findMissing` accepts at most 1,000 strict 64-byte digests, so its
      // serialized request cannot reach the 256 KiB protocol ceiling. The
      // assertion remains beside serialization to fail closed if either
      // invariant changes.
      "smithers/flows/artifacts/src/RemoteArtifacts.ts": 1,
      // Doctor's SQLite adapter throws Error values, and Gc's closed retention
      // failure contract does the same; their fallbacks
      // keep diagnostics total if those dependencies widen in the future.
      "smithers/src/Doctor.ts": 1,
      "smithers/src/Gc.ts": 2,
      // Control's three arms sit behind the mutation boundary: every caller
      // hands `principalOf` a mutation the boundary already decoded into a
      // struct, and an unpaired high or lone low surrogate is refused there
      // before the redaction helper can meet it. TestControl's deterministic
      // runtime derives every identifier from a counter, so the random-byte
      // primitive `Crypto.make` requires is never asked for bytes.
      "smithers/control/src/ControlLive.ts": 3,
      "smithers/control/src/test/TestControl.ts": 1,
      // The rest of control's arms defend invariants its own code establishes:
      // a run is attributed only once one of its three cancellation sources
      // exists, so the trailing zero in `Cancellation` is unreachable; a
      // `Uint8Array` host always has the prototype accessors `Channels`
      // refuses to run without; the runtime's approval and target maps are
      // keyed by the identity they are compared against, and one process
      // writes `fence` and `localFence` together; `planning` is called only by
      // `launch`, which has the run it just started; and `Lineage` has already
      // refused an edge with no parent before `originOf` could answer nothing.
      // The transport classification added in 97c703dc0d brought the rest:
      // `ControlClient` reads a status only off a `StatusCodeError` cause,
      // which always carries a response with a numeric status, and re-raises
      // an interrupt-only cause the fiber never delivers to that operator;
      // the in-memory runtime's plan and approval maps are keyed by the
      // identity they are compared against, so a stored row can only
      // disagree with its key after a reach into private state; and
      // `SqlControlRuntime` defends the SQLite driver's nested error objects,
      // the PostgreSQL and MySQL "missing table" phrasings rc.0 never meets,
      // a `RETURNING` row the same statement just inserted, an ancestor walk
      // that only revisits ids it already stored, an absent decoded input the
      // card refuses first, and an approval-token read that finds neither the
      // row it inserted nor the one already there.
      "smithers/control/src/Cancellation.ts": 1,
      "smithers/control/src/Channels.ts": 1,
      "smithers/control/src/ControlClient.ts": 4,
      "smithers/control/src/ControlRuntime.ts": 5,
      "smithers/control/src/Lineage.ts": 1,
      "smithers/control/src/SqlControlRuntime.ts": 7,
      "smithers/control/src/internal/planning.ts": 1,
      // The agent package's former hints (FlowEngineLike's canonicalization
      // mappers and AgentSession's process-loss fallbacks) were removed with
      // the code that needed them in 81b218ce7; the entries leave with them.
      // Canonical capture rejects accessor properties before recursively
      // freezing the captured object graph, so the descriptor walk only sees
      // data properties in both identity implementations.
      // Graph's four guards defend invariants established by the same build:
      // every node has key material, recorded dependency targets exist, and
      // reachability suppresses duplicate dependencies before conflict edges
      // are added. They remain hard failures if a future pass breaks those
      // invariants.
      "smithers/flows/core/src/Graph.ts": 4,
      "smithers/flows/core/src/internal/node.ts": 1,
      // The YAML parser always attaches a position to parser issues and a
      // mapping always converts to a non-null object. Both guards keep the
      // redacted diagnostic path total across future parser upgrades.
      "smithers/flows/core/src/internal/skillFrontmatter.ts": 2,
      // Three unreachable-by-construction branches in the plan scheduler: the
      // ready-set can never be empty while work is pending (the compiler
      // rejects cycles), the dispatch key is built from strings so
      // canonicalization cannot reject it, and the merge node's elaboration
      // cannot hit any of `Plan.append`'s four refusals. Six more sit on the
      // per-file pinning and produced-match expansion paths: five
      // host-refusal translations that share the typed boundary-unavailable
      // path the prepare-failure tests exercise, and the no-FileSystem
      // refusal in `expandProducedMatches`, unreachable because
      // `observeReads` already failed the run for the same glob when no
      // FileSystem was composed.
      "smithers/flows/engine-store/src/PlanScheduler.ts": 9,
      // One `else` arm in recursive enumeration: special entries (symlinks,
      // sockets) are neither materializable leaves nor prunable scaffolding
      // and are intentionally discarded.
      // FileBoundary rejects upward and absolute removal declarations before
      // they reach the sandbox.
      "smithers/flows/engine-store/src/WorkspaceSandbox.ts": 1,
      "smithers/flows/engine-store/src/internal/RunCoordinator.ts": 1,
      // The inert-JSON reducer that admits an action's persisted value asks
      // the language for guarantees the language already makes: a non-proxy
      // array's `length` is a mandatory own data property holding a uint32,
      // a key returned by `Reflect.ownKeys` has a descriptor on a non-proxy
      // object, and the `typeof` switch above covers every value category.
      // Each guard turns a future host-reflection change into a rejected
      // value rather than a thrown persistence path.
      "smithers/flows/engine-store/src/internal/ActionPersistence.ts": 3,
      // `releaseOwned`'s successful arm is the generator's terminal
      // fallthrough; V8 emits no executable location for that synthetic
      // branch, so the `else` on the owned transition can never be covered.
      "smithers/flows/engine-store/src/internal/RunDriver.ts": 1,
      "smithers/flows/engine/src/FlowEngine/make.ts": 1,
      // The guest runner is resolved beside this module, and only a built
      // `dist` copy answers to the `.js` extension the arm covers.
      "smithers/flows/src/SandboxedFlow.ts": 1,
      // WebCrypto's digest refuses an unknown algorithm NAME, and the guest
      // names none outside `DigestAlgorithm`, so the rejection translation is
      // unreachable from the engine.
      "smithers/flows/src/internal/SandboxedFlowGuest.ts": 1,
      // ECMAScript arrays expose a uint32 own `length`; Proxy invariants do
      // not permit the descriptor-backed boundary walk to observe any other
      // shape. These guards keep future reflection changes fail-closed.
      "smithers/agent/fs/src/internal/Boundary.ts": 1,
      // Projection rows, selectors, cursors, and tags are decoded before the
      // internal frame and snapshot objects are assembled. Re-decoding those
      // same admitted fields cannot fail; the catches remain fail-closed if a
      // future assembly step adds an unvalidated member.
      "smithers/gateway/src/Projections.ts": 4,
      // `fenced`'s `info` and `body` groups are mandatory (outside any
      // alternation or quantifier), so they participate in every match; the
      // fallbacks only discharge the optional type on
      // `RegExpMatchArray.groups`.
      "smithers/agent/harness/src/Cell.ts": 2,
      // The lexer's alternation binds exactly one of its two groups on every
      // match, so the fallback only discharges the optional type on a
      // capture.
      "smithers/agent/harness/src/CellTurn.ts": 1,
      // `transpileModule` reports syntactic diagnostics only, and attaches a
      // source file and a position to every one of them; the position came
      // from the same text this splits. The third is the normalizer's
      // nameless-class guard: a top-level class with no name is only spellable
      // as `export default class {}`, and module syntax is refused before the
      // normalizer runs. All three discharge optional types rather than
      // reachable states.
      "smithers/agent/harness/src/CellValidation.ts": 3,
      // Four are limits: `withDefaults` fills each declared limit from
      // `defaultLimits`, so the optional chains, the coalesces and the heap
      // ceiling's `else` never take their fallbacks. One is the realm's
      // compile path, which needs the boundary parse and QuickJS to disagree
      // about what parses. The last is the bridge drain a frame interrupted
      // between two settled calls would leave behind: no deterministic test
      // produces that interleaving, and without the guard such a frame leaves
      // a live handle in a realm that outlives it.
      "smithers/agent/harness/src/QuickJSSandbox.ts": 6,
      // One coalesce over `validate`'s closed two-member answer. The five
      // beside it belonged to the same-realm binding — its `with` scope proxy
      // and the host cell's failure path — and left with it when the filing
      // surface was deleted.
      "smithers/agent/harness/src/Sandbox.ts": 1,
      // The first pass already ran the decoder over every entry of the same
      // `events` array and returned on failure, and `decode` is pure, so
      // re-decoding a surviving entry cannot fail; the branch exists because
      // `Result` has no way to carry that proof. Its twin left with the
      // transcript-replacement branch a `continue` used to take.
      "smithers/agent/harness/src/Transcript.ts": 1,
      // Published journal values come from acyclic decoded JSON; synchronous
      // queue size/take cannot disagree while admission is open; and bytes
      // just emitted by the JSON encoder decode immediately. The three guards
      // keep those boundaries fail-closed if an implementation changes.
      "smithers/flows/journal/src/SqlJournal.ts": 3,
      // A successful optimizer loop has run at least one body, so `attempts`
      // is non-empty; the fallback exists only because Loop's generic result
      // does not encode that postcondition.
      "smithers/flows/patterns/src/Optimizer.ts": 1,
      // `FileSet.Entry` is a closed two-member union, so the final
      // comparison arm's `else` and the fallthrough after every pair
      // returned are both unreachable by construction.
      "smithers/flows/plan/src/FileSet.ts": 2,
      "smithers/flows/plan/src/internal/node.ts": 1,
      // Every `flows_plans` column carries a CHECK constraint, so a row that
      // fails the row decode cannot be written.
      "smithers/flows/plan/src/PlanStore.ts": 1,
      // The planned-value placeholder's proxy target is callable only so the
      // `apply` trap fires; the target body itself is unreachable by
      // construction because every application enters the trap.
      "smithers/flows/plan/src/Planned.ts": 1,
      // The plugin boundary uses the same ECMAScript array-length invariant
      // as the fs boundary above, retaining a defensive refusal for a future
      // host-reflection change.
      "smithers/agent/plugin/src/internal/Boundary.ts": 1,
      "smithers/flows/run-store/src/AttemptStore.ts": 1,
      "smithers/flows/run-store/src/RunStore.ts": 3,
      "smithers/flows/run-store/src/internal/Boundary.ts": 1,
      // Provider processes can only originate from each provider's `spawn`,
      // which records the opaque handle before returning it. These guards
      // turn a future provenance violation into a typed unknown-process error.
      "smithers/flows/sandbox/src/AwsSandbox/make.ts": 1,
      "smithers/flows/sandbox/src/ContainerSandbox/make.ts": 1,
      // Session paths are absolute beneath an absolute root, so parent
      // creation is skipped only for the filesystem root. The second guard is
      // the same opaque-process provenance check as the remote providers.
      "smithers/flows/sandbox/src/DirectorySandbox/make.ts": 2,
      "smithers/flows/sandbox/src/JustBashSandbox/make.ts": 1,
      "smithers/flows/sandbox/src/KubernetesSandbox/make.ts": 1,
      // `spawn` is the only source of a `RemoteProcess`, and it records every
      // one it returns, so the scripted provider's kill lookup cannot miss.
      "smithers/flows/sandbox/src/RemoteChildProcessSpawner/TestRemote.ts": 1,
      // Every runtime this package supports carries Web Crypto, so the
      // `Math.random` fallback the conformance nonce keeps for a host without
      // it is unreachable from any supported host.
      "smithers/flows/sandbox/src/SandboxConformance/posixCommands.ts": 1,
      // The remote handle answers liveness from a local flag with
      // `Effect.sync`, so supervision's fallback for a failing `isRunning`
      // only discharges the error channel the handle type declares.
      "smithers/flows/sandbox/src/SandboxSupervision/make.ts": 1,
      // Splitting any string yields a first field; the nullish arm only
      // discharges noUncheckedIndexedAccess before the type lookup.
      "smithers/flows/sandbox/src/Sandbox/fileSystem.ts": 1,
      // Bounded inert JSON is exactly `@smthrs/canonical`'s accepted domain,
      // so the encoder's refusal arm is unreachable from an admitted row; the
      // other two are conflict arms whose blocking row is read inside the same
      // serialized write transaction that saw the insert fail.
      "smithers/flows/step-cache/src/CacheStore.ts": 3,
      // One defensive normalization for a future `Duration` input that throws,
      // and one path guard that `KeyDigest` already satisfies by excluding
      // every path separator and dot segment.
      "smithers/flows/step-cache/src/RemoteCacheStore.ts": 2,
      // One refusal half in the fault tier's `parentPid`. Every supported
      // platform's `ps` either prints one parent pid or exits non-zero into
      // the catch beside it, so neither empty output nor an unparsable first
      // field can occur; the guard stays because a platform that produced one
      // would otherwise report a parent of 0, which reads as "reparented to
      // init" and is the exact claim the orphan cases assert.
      "testing/src/Faults.ts": 1,
      // The fixture engine's three unreachable arms (`d1012596b6`): registered
      // execution bodies settle only after run or resume arms their
      // settlement, the registered execute function runs every subject flow so
      // the declarative body is never interpreted, and every path to
      // awaitResult arms a settlement after recording execution metadata.
      "testing/src/FlowEngineLike.ts": 3
    }
    const sourceFiles = (directory: string): Array<string> => {
      let entries
      try {
        entries = readdirSync(directory, { withFileTypes: true })
      } catch {
        return []
      }
      return entries.flatMap((entry) =>
        entry.isDirectory()
          ? sourceFiles(join(directory, entry.name))
          : entry.name.endsWith(".ts")
          ? [join(directory, entry.name)]
          : []
      )
    }
    const found: Record<string, number> = {}
    for (const name of packages) {
      for (const path of sourceFiles(join(packagesDir, name, "src"))) {
        const source = readFileSync(path, "utf8")
        const file = relative(packagesDir, path)
        let count = 0
        for (const match of source.matchAll(directive)) {
          const form = match[1]
          // The `file` form drops the ENTIRE file out of the 100%
          // denominator, and start/stop ranges hide arbitrarily large
          // regions behind a single allowlist count — all three are
          // forbidden outright, never allowlisted (issue #157).
          expect(
            form,
            `${file} uses the forbidden "ignore ${form}" form: "${match[0]}"`
          ).not.toMatch(/^(?:file|start|stop)$/)
          count += 1
        }
        if (count > 0) {
          found[file] = count
        }
      }
    }
    // The rule this cell exists to enforce, and the one the diff above is
    // usually reporting: a coverage-ignore hint and the entry that admits it
    // land in the SAME commit, with a comment paraphrasing why the branch is
    // unreachable. Re-derive a moved count from the file on disk rather than
    // from a review note, and read the directive before blessing it: a count
    // pinned against a working tree nobody has committed moves again the next
    // time that lane rebases.
    expect(
      found,
      "a coverage-ignore hint and its entry here land in the same commit: read each directive, then pin its count"
    ).toEqual(allowlist)
  })
})
