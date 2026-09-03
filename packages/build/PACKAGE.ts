/**
 * Targets for the `@smthrs/build` package plus the declarations it
 * carried as a standalone workspace root:
 *
 * - `lib`, `check`, `test`, `lint`, `fmt`, and `docs` are this package's own
 *   standard targets. This PACKAGE.ts suppresses default-target synthesis, so
 *   they must be declared here explicitly.
 * - `template` is the inert shared manifest every package merges under.
 * - `packageDefaults` synthesizes a standard package's targets, and its
 *   manifest targets, for any `packages/*` directory without a PACKAGE.ts.
 *   Its glob anchors at this package, so in the Smithers monorepo it matches
 *   nothing; the workspace-wide declaration lives in the root PACKAGE.ts.
 * - `newPackage` is the `run` target that creates such a directory.
 */
import { Smithers } from "@smthrs/targets"
import { bunRuntime, packageManager } from "../../PACKAGE.ts"

const standard = Smithers.StandardPackage({ packageManager, cwd: "packages/build" })

const lib = standard.lib
const check = standard.check
const lint = standard.lint
const fmt = standard.fmt
const docs = standard.docs
const circular = standard.circular

/**
 * The package suite, with every prose surface its documentation contract
 * reads declared as key material.
 *
 * `StandardPackage.test` knows only `src/` and `test/`. `Docs.test.ts` also
 * reads the package's Markdown, deployment declaration, self-hosted
 * credential configuration, and the CLI's command registrations in
 * `packages/build-cli/src/Cli.ts`. Leaving those paths undeclared let a cached
 * test result survive a contradictory documentation edit, so this target is
 * the standard Vitest declaration with that complete read set.
 */
const test = Smithers.Vitest({
  packageManager,
  tests: [Smithers.glob("test/**/*.test.ts")],
  sources: [
    Smithers.glob("src/**/*.ts"),
    Smithers.file("README.md"),
    Smithers.file("DESIGN.md"),
    Smithers.glob("docs/**/*.md"),
    Smithers.glob("infra/**/*.md"),
    Smithers.file("infra/alchemy.run.ts"),
    Smithers.file("terraform/modules/cache/service/config.js"),
    Smithers.file("//packages/build-cli/src/Cli.ts")
  ],
  deps: [lib],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd: "packages/build"
})

/**
 * Runs the self-hosted cache service's suite.
 *
 * `standard.test` is a Vitest target over `test/**` and `vitest.config.ts`
 * says so, so nothing ran the five suites beside
 * `terraform/modules/cache/service`: a 965-line protocol, a 409-line Postgres
 * translation, and its configuration contract were gated by no target at all,
 * and the repository invariant is that a gate becomes a target in the package
 * that owns it before CI can run it.
 *
 * It runs under Bun rather than the declared Node runtime because the service
 * is a Bun program: it hashes with `Bun.CryptoHasher` and its suites import
 * `bun:test`. The suite also runs the conformance corpus against
 * `infra/worker/protocol.ts`, which is why that file is an input. Nothing here
 * needs a database or a listener. `postgres_test.js`
 * is discovered too and guards itself with
 * `describe.skipIf(!process.env.SMITHERS_CACHE_TEST_DATABASE_URL)`, so it
 * skips here and runs only where an operator points it at a real Postgres.
 *
 * @since 0.1.0
 * @category test
 */
const cacheService = Smithers.NodeTest({
  runtime: bunRuntime,
  runner: Smithers.testSuite(["terraform/modules/cache/service/test"]),
  srcs: [
    Smithers.glob("//packages/build/terraform/modules/cache/service/*.js"),
    Smithers.glob("//packages/build/terraform/modules/cache/service/test/*.js"),
    Smithers.file("//packages/build/infra/worker/protocol.ts")
  ],
  deps: [],
  cwd: "packages/build"
})

/**
 * The manifest fields every package in this workspace shares.
 *
 * Scripts here are literal commands: a template is workspace wide and cannot
 * name one package's targets. A package binds its own targets in its own
 * `scripts`, where the command is derived from the resolved label.
 */
export const template = Smithers.PackageJsonTemplate.make({
  type: "module",
  license: "MIT",
  author: "Smithers",
  sideEffects: [],
  engines: { node: ">=22.19.0" },
  scripts: Smithers.PackageJsonTemplate.standardScripts
})

/**
 * Standard package defaults.
 *
 * A directory under `packages/` with a `package.json` and no `PACKAGE.ts` gets
 * the six conventional targets plus `packageJsonCheck`, `packageJsonWrite`,
 * and `packageJsonRefresh`. `packageJsonCheck` runs under `lint` and `ci`; the
 * two writing targets run under `run` alone.
 */
export const packageDefaults = Smithers.PackageDefaults({
  directories: "packages/*",
  marker: "package.json",
  macro: (attrs: { readonly cwd: string }) => {
    const standard = Smithers.StandardPackage({ packageManager, deps: [], cwd: attrs.cwd })
    return {
      ...standard,
      packageJson: Smithers.PackageJson({
        name: `@smthrs/${attrs.cwd.split("/").at(-1) ?? attrs.cwd}`,
        version: "0.1.0",
        template,
        scripts: { build: standard.lib, lint: standard.lint },
        publish: { entry: standard.lib }
      })
    }
  }
})

/**
 * Scaffolds a new workspace package.
 *
 * ```sh
 * smithers-build run //:newPackage --name @smthrs/widget
 * ```
 */
const newPackage = Smithers.NewPackage({
  directory: "packages",
  version: "0.1.0",
  license: "MIT",
  fields: template.fields,
  tsconfigExtends: "../../tsconfig.json"
})

export const Package = Smithers.Package({
  targets: { cacheService, check, circular, docs, fmt, lib, lint, newPackage, test }
})
