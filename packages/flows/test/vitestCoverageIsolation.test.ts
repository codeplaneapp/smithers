import { readdirSync, readFileSync, statSync } from "node:fs"
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
  const packagesDir = resolve(import.meta.dirname, "..", "..")
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
  const packages = readdirSync(packagesDir).filter((name) => isFile(join(packagesDir, name, "package.json")))
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
    expect(names).toContain("flows")
    expect(names).toContain("kernel")
    expect(names.length).toBeGreaterThanOrEqual(11)
  })

  it.each(configs)("$name ships a vitest config at all (issue #148)", ({ path, source }) => {
    // An empty source means the package exists but has no config file —
    // the exact omission the config-derived universe could never see.
    expect(source, `${path} is missing`).not.toBe("")
  })

  it.each(packages.map((name) => ({ name })))(
    "$name retains Effect-style source exports and declares built publication exports",
    ({ name }) => {
      const manifest = JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8")) as {
        readonly exports?: Record<string, string>
        readonly publishConfig?: {
          readonly exports?: Record<string, string | Record<string, string>>
        }
      }
      expect(manifest.exports?.["."]).toBe("./src/index.ts")
      expect(manifest.exports?.["./*"]).toBe("./src/*.ts")
      for (const subpath of [".", "./*"] as const) {
        const target = manifest.publishConfig?.exports?.[subpath]
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
      expect(source).toContain(`flows-${name}-coverage`)
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
  const coverageFloorDeferred = new Set([
    "cli",
    "control",
    "core",
    "evals",
    "fs",
    "memory",
    "model",
    "patterns",
    "registry",
    "scorers",
    "std",
    "testing",
    "triggers",
    "build",
    "build-cli",
    "targets"
  ])

  const assertCoverageDenominator = (source: string) => {
    expect(source).toMatch(/coverage:\s*\{[^]*?enabled:\s*true/)
    expect(source).toMatch(/include:\s*\[\s*"src\/\*\*(?:\/\*\.ts)?"\s*\]/)
    expect(source).toMatch(/provider:\s*"v8"/)
    // A test-runner `test.exclude` is legitimate (for example fixture source
    // that is not a test). Only exclusions inside the coverage block shrink
    // the production denominator.
    expect(source).not.toMatch(/coverage:\s*\{[^]*?\bexclude\s*:/)
    expect(source).not.toMatch(/\bautoUpdate\s*:/)
    expect(source).not.toMatch(/\ball\s*:/)
    expect(source).not.toMatch(/\bextension\s*:/)
    expect(source).not.toMatch(/\bignoreClassMethods\s*:/)
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
    ({ source }) => {
      assertCoverageDenominator(source)
      const thresholds = source.match(/thresholds:\s*\{([^{}]*)\}/)
      expect(thresholds).not.toBeNull()
      const pinned = thresholds?.[1] ?? ""
      const values = [...pinned.matchAll(/\b(branches|functions|lines|statements):\s*(\d+)/g)]
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
    ({ source }) => {
      // The thresholds are the primary regression gate, so the gate itself
      // is pinned cross-package: a sibling that drops `enabled: true`,
      // lowers a threshold, or narrows `include` must fail HERE, not go
      // silently un-enforced with its own suite green.
      assertCoverageDenominator(source)
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
    // `packages/build/infra` is the hosted cache Cloudflare Worker that ships
    // inside the `smthrs` package. It is private and unpublished, and it is a
    // workspace member only so its own vitest suite and `tsc --noEmit` run under
    // the root fan-out instead of being dead code. It is NESTED under
    // `packages/build`, so the `packages/` universe derivation above — which
    // reads top-level directories only — is unaffected and no top-level
    // publishable surface escapes the gate. `sharp` and `workerd` are its
    // wrangler toolchain's postinstall builds, denied like every other.
    // Widened a third time for the deployable applications. `apps/*` contains
    // private entry points rather than published library packages; each app's
    // own test/build scripts participate in the root recursive gates, while
    // the package publication/coverage universe remains `packages/*`.
    //
    const workspace = readFileSync(join(packagesDir, "..", "pnpm-workspace.yaml"), "utf8")
    const packagesBlock = workspace.match(/^packages:\n(?:  - .+\n)+/m)?.[0]
    expect(packagesBlock).toBe(
      [
        "packages:",
        "  - \"packages/*\"",
        "  - \"packages/build/infra\"",
        "  - \"examples\"",
        "  - \"apps/*\"",
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
    // `--workspace packages/flows` — silently dropped siblings from CI while
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
    const root = JSON.parse(readFileSync(join(packagesDir, "..", "package.json"), "utf8")) as {
      readonly scripts?: Record<string, string>
    }
    expect(root.scripts).toEqual({
      browser: "node scripts/browser-check.mjs",
      check: "pnpm --recursive --if-present run check",
      circular: "pnpm --recursive --if-present run circular",
      "deploy:dry": "pnpm --filter smithers-server run deploy:dry",
      dev: "pnpm --filter smithers-ui run start",
      lint: "pnpm --recursive --if-present run lint",
      test: "pnpm --recursive --if-present run test",
      "test:examples": "pnpm --filter @smthrs/examples run test",
      "test:jsdoc": "node --test scripts/eslint-jsdoc.test.mjs"
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
    // named as raw strings in BUILD.ts. They are targets now, so what is pinned
    // is the verb-and-pattern invocation that plans them: `smthrs ci` over the
    // package graph covers lib, check, test, lint, fmt, docs, and circular for
    // every package, and the browser contract is its own labelled target.
    const ci = readFileSync(join(packagesDir, "..", ".github", "workflows", "ci.yml"), "utf8")
    expect(ci).toMatch(/^\s*- uses: pnpm\/action-setup@v6$/m)
    expect(ci).toMatch(/^\s*- run: pnpm install --frozen-lockfile --ignore-scripts$/m)
    expect(ci).toMatch(/^\s*run: pnpm exec smthrs ci '\/\/packages\/\.\.\.'/m)
    expect(ci).toMatch(/^\s*run: pnpm exec smthrs test '\/\/scripts\/\.\.\.'$/m)
    // Browser support is a hard requirement met through layers; the browser
    // contract target is the only thing that proves it, so CI has to run it
    // (REVIEW.md blocker 7).
    expect(ci).toMatch(/^\s*run: pnpm exec smthrs test '\/\/scripts:browserContract'$/m)
    expect(ci).toMatch(/^\s*run: pnpm exec smthrs test '\/\/packages\/\.\.\.'$/m)
    expect(ci).toMatch(/tool: jj-cli@\d+\.\d+\.\d+/)
    expect(ci).toMatch(/^\s*run: jj git init --colocate$/m)
  })

  it("keeps every CI step a target invocation, never a hand-written command", () => {
    // The rule this pins: a BUILD.ts file declares targets, and the argv a
    // target runs is rendered inside its implementation. A `run:` line in the
    // generated workflow that is not a target invocation, an install, or a
    // toolchain step derived from a declaration would mean someone reopened the
    // free-form step surface that `GithubCiGen` deleted.
    const ci = readFileSync(join(packagesDir, "..", ".github", "workflows", "ci.yml"), "utf8")
    const commands = [...ci.matchAll(/^\s*(?:- )?run: (?!\|)(.+)$/gm)].map((match) => match[1]!)
    expect(commands.length).toBeGreaterThan(0)
    const derived = [
      /^pnpm exec smthrs (?:build|test|lint|docs|ci) '\/\/[^']*'( --jobs \d+)?$/,
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
      // The agent package's former hints (FlowEngineLike's canonicalization
      // mappers and AgentSession's process-loss fallbacks) were removed with
      // the code that needed them in 81b218ce7; the entries leave with them.
      // Canonical capture rejects accessor properties before recursively
      // freezing the captured object graph, so the descriptor walk only sees
      // data properties in both identity implementations.
      "core/src/internal/node.ts": 1,
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
      "engine-store/src/PlanScheduler.ts": 9,
      // One `else` arm in recursive enumeration: special entries (symlinks,
      // sockets) are neither materializable leaves nor prunable scaffolding
      // and are intentionally discarded.
      "engine-store/src/internal/FileEnumeration.ts": 1,
      // FileBoundary rejects upward and absolute removal declarations before
      // they reach the sandbox.
      "engine-store/src/WorkspaceSandbox.ts": 1,
      "engine-store/src/internal/RunCoordinator.ts": 1,
      // `releaseOwned`'s successful arm is the generator's terminal
      // fallthrough; V8 emits no executable location for that synthetic
      // branch, so the `else` on the owned transition can never be covered.
      "engine-store/src/internal/RunDriver.ts": 1,
      "engine/src/FlowEngine/make.ts": 1,
      // `fenced`'s `info` and `body` groups are mandatory (outside any
      // alternation or quantifier), so they participate in every match; the
      // fallbacks only discharge the optional type on
      // `RegExpMatchArray.groups`.
      "harness/src/Cell.ts": 2,
      // The lexer's alternation binds exactly one of its two groups on every
      // match, so the fallback only discharges the optional type on a
      // capture.
      "harness/src/CellTurn.ts": 1,
      // `transpileModule` reports syntactic diagnostics only, and attaches a
      // source file and a position to every one of them; the position came
      // from the same text this splits. The third is the normalizer's
      // nameless-class guard: a top-level class with no name is only spellable
      // as `export default class {}`, and module syntax is refused before the
      // normalizer runs. All three discharge optional types rather than
      // reachable states.
      "harness/src/CellValidation.ts": 3,
      // Four are limits: `withDefaults` fills each declared limit from
      // `defaultLimits`, so the optional chains, the coalesces and the heap
      // ceiling's `else` never take their fallbacks. One is the realm's
      // compile path, which needs the boundary parse and QuickJS to disagree
      // about what parses. The last is the bridge drain a frame interrupted
      // between two settled calls would leave behind: no deterministic test
      // produces that interleaving, and without the guard such a frame leaves
      // a live handle in a realm that outlives it.
      "harness/src/QuickJSSandbox.ts": 6,
      // One coalesce over `validate`'s closed two-member answer. The five
      // beside it belonged to the same-realm binding — its `with` scope proxy
      // and the host cell's failure path — and left with it when the filing
      // surface was deleted.
      "harness/src/Sandbox.ts": 1,
      // Both callers pass an `Error` (`JSON.parse` throws `SyntaxError`;
      // `Schema.decodeUnknownEffect` fails with `SchemaError`, which extends
      // `Error`), so the `String` arm only discharges the `unknown` a `catch`
      // binding and a schema failure channel are typed as.
      "harness/src/StructuredOutput.ts": 1,
      // The first pass already ran the decoder over every entry of the same
      // `events` array and returned on failure, and `decode` is pure, so
      // re-decoding a surviving entry cannot fail; the branch exists because
      // `Result` has no way to carry that proof. Its twin left with the
      // transcript-replacement branch a `continue` used to take.
      "harness/src/Transcript.ts": 1,
      "journal/src/SqlJournal.ts": 1,
      // `FileSet.Entry` is a closed two-member union, so the final
      // comparison arm's `else` and the fallthrough after every pair
      // returned are both unreachable by construction.
      "plan/src/FileSet.ts": 2,
      "plan/src/internal/node.ts": 1,
      // Two unreachable-by-construction fallbacks in the plan compiler. Plan
      // order closes every dependency before its dependent, so the
      // transitive-closure fallback is unreachable; and the reader-after-writer
      // pass walks an edge map keyed by every node of the plan, whose values
      // hold node ids only, so its `edges.get(current)` lookup always hits.
      "plan/src/Plan.ts": 2,
      // Every `flows_plans` column carries a CHECK constraint, so a row that
      // fails the row decode cannot be written.
      "plan/src/PlanStore.ts": 1,
      // The planned-value placeholder's proxy target is callable only so the
      // `apply` trap fires; the target body itself is unreachable by
      // construction because every application enters the trap.
      "plan/src/Planned.ts": 1,
      "run-store/src/AttemptStore.ts": 1,
      "run-store/src/RunStore.ts": 1,
      "step-cache/src/CacheStore.ts": 1
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
    expect(found).toEqual(allowlist)
  })
})
