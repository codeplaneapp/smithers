// Package-mode port of scripts/BUILD.ts. Every gate under scripts/ is a
// Shell.Test running the declared runtime (NodeTest -> Shell.Test per the
// translation table in docs/migration/package-mode-port.md); the release
// steps that mutate the tree or a registry are approval-gated Shell.Run.
import { Smithers as S } from "@smthrs/targets"

// Both extensions: the version guard and the invocation normalizer are
// TypeScript, and a glob that saw only .mjs would leave an edit to either
// one out of every gate's digest.
const srcs = S.Filegroup({ srcs: S.glob(["**/*.mjs", "**/*.ts"]) })

// The pack directory the release rehearsal writes and the smoke check reads.
const packDirectory = "dist/release-packs"

const node = S.Runtime.bin

/** `node --test` over the named suites. */
const testRunner = (files: ReadonlyArray<string>) =>
  S.Shell.Test({
    bin: node,
    args: ["--test", ...files],
    data: [srcs]
  })

// --- release manifest and rehearsal gates -------------------------------

const packManifest = testRunner(["pack-release.test.mjs"])

const releaseRehearsal = S.Shell.Test({
  bin: node,
  args: ["--test", "release-rehearsal.test.mjs"],
  data: [srcs, S.file("//.github/workflows/release.yml")]
})

const releaseVersion = testRunner(["set-release-version.test.mjs"])

const disasterRecovery = testRunner(["flows-backup.test.mjs"])

const testPinRegister = testRunner(["check-test-pins.test.mjs"])

// --- check-*.mjs entry-point gates --------------------------------------

const gate = (file: string) =>
  S.Shell.Test({
    script: S.file(file),
    data: [srcs]
  })

const browserContract = gate("browser-check.mjs")
const dependencyBoundaries = gate("check-dependency-boundaries.mjs")
const docs = gate("check-docs.mjs")
const llms = gate("check-llms.mjs")
const localSmithers = gate("check-local-smithers.mjs")
const lockfilePair = gate("check-lockfile-pair.mjs")
const testPins = gate("check-test-pins.mjs")

const effectVersion = S.Shell.Test({
  script: S.file("check-single-effect-version.mjs"),
  data: [srcs, S.file("//pnpm-lock.yaml"), S.file("//bun.lock")]
})

// Resolves against the live registry through npm's arborist.
const npmDedupe = S.Shell.Test({
  script: S.file("check-npm-dedupe.mjs"),
  data: [srcs],
  sandbox: { network: true }
})

// The Phase 7 gate: red while legacy/ exists, green after its removal. It is
// declared so it is addressable, and kept out of the ci suite until Phase 7.
const legacyAbsent = gate("check-legacy-absent.mjs")

// --- unit suites behind the gates ---------------------------------------

const npmDedupeUnit = testRunner(["check-npm-dedupe.test.mjs"])
const localSmithersUnit = testRunner(["check-local-smithers.test.mjs"])
const eslintJsdocUnit = testRunner(["eslint-jsdoc.test.mjs"])

const docsUnit = testRunner([
  "check-llms.test.mjs",
  "docs-contract.test.mjs",
  "docs-deploy.test.mjs",
  "docs-links.test.mjs",
  "docs-removals.test.mjs",
  "docs-render.test.mjs",
  "docs-routes.test.mjs",
  "docs-sidebar.test.mjs",
  "generate-docs-pages.test.mjs",
  "generate-llms.test.mjs",
  "llms-version-guard.test.ts",
  "normalize-bunx.test.ts"
])

// --- release execution --------------------------------------------------

// Packs every publishable package into packDirectory: a build whose product
// the smoke check installs from.
const releasePack = S.Shell.Build({
  script: S.file("pack-release.mjs"),
  args: [packDirectory],
  data: [srcs],
  outDirs: [packDirectory]
})

const releaseSmoke = S.Shell.Test({
  script: S.file("smoke-release.mjs"),
  args: [packDirectory],
  data: [srcs, releasePack]
})

// Mutates every workspace manifest to the requested version; runs only when
// named, behind an approval.
const setReleaseVersionRun = S.Shell.Run({
  script: S.file("set-release-version.mjs"),
  data: [srcs],
  approval: "required"
})

// The full pack-install-import rehearsal entry point operators run before a
// tag; it writes outside the pack directory, so it is a gated run.
const releaseRehearsalRun = S.Shell.Run({
  script: S.file("release-rehearsal.mjs"),
  data: [srcs],
  approval: "required",
  sandbox: { network: true }
})

const ci = S.Suite({
  tests: [
    packManifest,
    releaseRehearsal,
    releaseVersion,
    disasterRecovery,
    testPinRegister,
    testPins,
    browserContract,
    dependencyBoundaries,
    docs,
    docsUnit,
    effectVersion,
    eslintJsdocUnit,
    llms,
    localSmithers,
    localSmithersUnit,
    lockfilePair,
    npmDedupe,
    npmDedupeUnit,
    releaseSmoke
  ]
})

export const Package = S.Package({
  targets: {
    srcs,
    packManifest,
    releaseRehearsal,
    releaseVersion,
    disasterRecovery,
    testPinRegister,
    testPins,
    browserContract,
    dependencyBoundaries,
    docs,
    docsUnit,
    effectVersion,
    eslintJsdocUnit,
    legacyAbsent,
    llms,
    localSmithers,
    localSmithersUnit,
    lockfilePair,
    npmDedupe,
    npmDedupeUnit,
    releasePack,
    releaseSmoke,
    releaseRehearsalRun,
    setReleaseVersionRun,
    ci
  }
})
