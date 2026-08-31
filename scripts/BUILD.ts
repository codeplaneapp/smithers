/**
 * Targets for the repository's operator and release scripts.
 *
 * Every gate under `scripts/` is declared here, so `smithers-build test '//scripts/...'`
 * is the whole of what CI used to spell as seven `node --test …` and
 * `node scripts/….mjs` strings. The scripts keep living beside the thing they
 * guard; what changed is that the build system now knows about them, which means
 * they are planned, addressable by label, and runnable locally by the same name
 * the pipeline uses.
 *
 * The interpreter comes from the root runtime declaration. Nothing here spells
 * `node`.
 */
import { Smithers } from "@smthrs/targets"
import { runtime } from "../BUILD.ts"

/**
 * Everything under `scripts/`, digested as the input of every gate here.
 *
 * Both extensions: the version guard and the invocation normalizer are
 * TypeScript, and a glob that saw only `.mjs` would leave an edit to either one
 * out of the digest every gate here is keyed on.
 */
const sources = [Smithers.glob("//scripts/**/*.mjs"), Smithers.glob("//scripts/**/*.ts")]

/**
 * The pack directory the release rehearsal writes and the smoke check reads.
 *
 * Workspace-relative and gitignored. On CI this used to be a runner temporary
 * directory named by an environment expression, which made the two steps agree
 * only by both interpolating the same string.
 */
const packDirectory = "dist/release-packs"

/**
 * Checks the release manifest: which packages are published, in what order, and
 * with which internal ranges retargeted.
 *
 * @since 0.1.0
 * @category test
 */
export const packManifest = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//scripts/pack-release.test.mjs")]),
  srcs: sources,
  deps: []
})

/**
 * Checks that the dry-run path of `release.yml` skips publication and that a tag
 * push does not.
 *
 * The assertions read `release.yml` itself, so an edit that breaks either half
 * fails here instead of at the next release.
 *
 * @since 0.1.0
 * @category test
 */
export const releaseRehearsal = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//scripts/release-rehearsal.test.mjs")]),
  srcs: [...sources, Smithers.file("//.github/workflows/release.yml")],
  deps: []
})

/**
 * Checks that publishing at a new version retargets the exact internal ranges
 * too, and that the tree is coherent at whatever version it currently carries.
 *
 * @since 0.1.0
 * @category test
 */
export const releaseVersion = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//scripts/set-release-version.test.mjs")]),
  srcs: sources,
  deps: []
})

/**
 * Drives the operator's backup, verify, and restore entry point the way an
 * operator drives it: spawned invocations against a real migrated store.
 *
 * @since 0.1.0
 * @category test
 */
export const disasterRecovery = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//scripts/flows-backup.test.mjs")]),
  srcs: sources,
  deps: []
})

/**
 * Fails on any pin in the engine or tooling groups that `docs/alpha-notes.md`
 * does not explain.
 *
 * A test the default gate never runs to a pass is only acceptable when it is
 * written down.
 *
 * @since 0.1.0
 * @category test
 */
export const testPinRegister = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//scripts/check-test-pins.test.mjs")]),
  srcs: sources,
  deps: []
})

/**
 * The browser contract, executed.
 *
 * Browser support is a hard requirement met through layers: the contract entry
 * points must bundle for the browser, and the documented Node-only ones must
 * still fail, and fail only on a documented `node:` built-in. This gates both
 * halves.
 *
 * @since 0.1.0
 * @category test
 */
export const browserContract = Smithers.NodeTest({
  runtime,
  runner: Smithers.entrypoint(Smithers.file("//scripts/browser-check.mjs")),
  // The entry points this bundles live in other packages, and a declared glob
  // may not cross a package boundary — it would expand to nothing and read as
  // a contract it is not. The gate is not cacheable, so it re-runs regardless.
  srcs: sources,
  deps: []
})

/**
 * Packs every publishable workspace package into {@link packDirectory}.
 *
 * A build target rather than a test: its product is the pack tree the smoke
 * check then installs from.
 *
 * @since 0.1.0
 * @category build
 */
export const releasePack = Smithers.NodeBinary({
  runtime,
  entry: Smithers.file("//scripts/pack-release.mjs"),
  args: [packDirectory],
  srcs: sources,
  deps: []
})

/**
 * Installs the packed artifacts into a scratch project and imports every
 * published entry point, ESM and CJS.
 *
 * The dependency edge on {@link releasePack} is what sequences the two; before
 * this target they were two shell lines in one step that agreed only by naming
 * the same environment variable.
 *
 * @since 0.1.0
 * @category test
 */
export const releaseSmoke = Smithers.NodeTest({
  runtime,
  runner: Smithers.entrypoint(Smithers.file("//scripts/smoke-release.mjs"), [packDirectory]),
  srcs: sources,
  deps: [releasePack]
})

/**
 * One `effect` version across every manifest, both lockfiles, and the install.
 *
 * Two Effect instances do not share schema internals, so a duplicate is a
 * runtime defect rather than a size problem. `rc-contract.md` section 9 pins
 * the supported range to one version and this target proves the tree agrees.
 *
 * @since 0.1.0
 * @category test
 */
export const effectVersion = Smithers.NodeTest({
  runtime,
  runner: Smithers.entrypoint(Smithers.file("//scripts/check-single-effect-version.mjs")),
  srcs: [...sources, Smithers.file("//pnpm-lock.yaml"), Smithers.file("//bun.lock")],
  deps: []
})

/**
 * What an npm consumer of the published set actually resolves.
 *
 * pnpm settles every internal edge from one workspace-wide pin, so
 * {@link effectVersion} stays green while an npm install of the same tarballs
 * duplicates Effect or drags a test runner into a production dependency tree.
 * This packs the release manifests, resolves them with npm's own arborist, and
 * asserts a single `effect` copy and no optional peer in the default install.
 *
 * The resolution reads registry metadata, so this target needs the network and
 * is not cacheable. It re-runs regardless, which is what a gate over an
 * external resolver has to do.
 *
 * @since 0.1.0
 * @category test
 */
export const npmDedupe = Smithers.NodeTest({
  runtime,
  runner: Smithers.entrypoint(Smithers.file("//scripts/check-npm-dedupe.mjs")),
  srcs: sources,
  deps: []
})

/**
 * The gate's own two claims, named one per cell.
 *
 * The script reports both through one exit code, so a regression reads as an
 * opaque failure. This suite says which claim broke and which package broke it.
 *
 * @since 0.1.0
 * @category test
 */
export const npmDedupeUnit = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//scripts/check-npm-dedupe.test.mjs")]),
  srcs: sources,
  deps: []
})

/**
 * Every import a workspace source makes is declared by that workspace.
 *
 * pnpm links the whole workspace under one `node_modules`, so an undeclared
 * import of a sibling still resolves locally and then fails for a consumer who
 * installs the tarball. This is PLAN.md Phase 3's "no package imports files
 * through unpublished workspace-relative paths", executed.
 *
 * The sources it reads live in other packages, and a declared glob may not
 * cross a package boundary, so `srcs` names only this directory. The gate is
 * therefore not cacheable and re-runs regardless.
 *
 * @since 0.1.0
 * @category test
 */
export const dependencyBoundaries = Smithers.NodeTest({
  runtime,
  runner: Smithers.entrypoint(Smithers.file("//scripts/check-dependency-boundaries.mjs")),
  srcs: sources,
  deps: []
})

/**
 * Internal scripts execute the Smithers working tree, never an installed copy.
 *
 * A published-CLI invocation inside this repository silently runs a release
 * build instead of the code under edit. The guard scans only positions that
 * actually spawn a process, so the documentation's own `bunx smithers-build` prose
 * stays legal.
 *
 * @since 0.1.0
 * @category test
 */
export const localSmithers = Smithers.NodeTest({
  runtime,
  runner: Smithers.entrypoint(Smithers.file("//scripts/check-local-smithers.mjs")),
  srcs: sources,
  deps: []
})

/**
 * The guard's own unit suite: the violation patterns, the allowlist, and the
 * mirrored plugin resolvers.
 *
 * @since 0.1.0
 * @category test
 */
export const localSmithersUnit = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//scripts/check-local-smithers.test.mjs")]),
  srcs: sources,
  deps: []
})

/**
 * The documentation gate: house style, page shape, links, the CLI catalog
 * against the binary, the removed surfaces, the generated pages, and the route
 * plan.
 *
 * It spawns the working-tree CLI to read `--help`, so it is not cacheable and
 * re-runs regardless.
 *
 * @since 0.1.0
 * @category test
 */
export const docs = Smithers.NodeTest({
  runtime,
  runner: Smithers.entrypoint(Smithers.file("//scripts/check-docs.mjs")),
  srcs: sources,
  deps: []
})

/**
 * The bundles `smithers docs`, the installed skill, and smithers.sh serve are
 * regenerated from `docs/pages` and compared byte for byte.
 *
 * @since 0.1.0
 * @category test
 */
export const llms = Smithers.NodeTest({
  runtime,
  runner: Smithers.entrypoint(Smithers.file("//scripts/check-llms.mjs")),
  srcs: sources,
  deps: []
})

/**
 * The unit suites behind those two gates: the served-bundle comparison, the
 * contract parser, the deploy workflow, the removal surface, the render
 * helpers, the help parser, the route plan, the sidebar, the bundle builder,
 * the version guard, and the invocation normalizer.
 *
 * @since 0.1.0
 * @category test
 */
export const docsUnit = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([
    Smithers.file("//scripts/check-llms.test.mjs"),
    Smithers.file("//scripts/docs-contract.test.mjs"),
    Smithers.file("//scripts/docs-deploy.test.mjs"),
    Smithers.file("//scripts/docs-links.test.mjs"),
    Smithers.file("//scripts/docs-removals.test.mjs"),
    Smithers.file("//scripts/docs-render.test.mjs"),
    Smithers.file("//scripts/docs-routes.test.mjs"),
    Smithers.file("//scripts/docs-sidebar.test.mjs"),
    Smithers.file("//scripts/generate-docs-pages.test.mjs"),
    Smithers.file("//scripts/generate-llms.test.mjs"),
    Smithers.file("//scripts/llms-version-guard.test.ts"),
    Smithers.file("//scripts/normalize-bunx.test.ts")
  ]),
  srcs: sources,
  deps: []
})
