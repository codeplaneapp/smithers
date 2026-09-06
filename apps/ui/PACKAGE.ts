/**
 * Targets for the UI application: typecheck, unit suite and browser tier.
 *
 * Playwright T1 runs in the dedicated PR browser job. Packaged Electrobun
 * remains a separate operator tier; see docs/LOCAL-APP.md "Test tiers".
 *
 * The unit suite uses the declared Bun runtime. SDK preparation and typecheck
 * use the workspace's Node runtime and package manager.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "apps/ui"

/** The application sources every suite drives. */
const sources = Smithers.glob("//apps/ui/src/**/*.ts")

/** The React components, part of the typecheck's and unit suite's key material. */
const componentSources = Smithers.glob("//apps/ui/src/**/*.tsx")

/** The stylesheets the SPA bundles; a CSS-only change must invalidate the unit cache too. */
const styleSources = Smithers.glob("//apps/ui/src/**/*.css")

/** The build/runtime configs the bundler reads. */
const buildConfigs = [
  Smithers.file("vite.config.ts"),
  Smithers.file("tailwind.config.js"),
  Smithers.file("postcss.config.js")
]

/**
 * The harness and suite sources outside `src/`. The tsconfig compiles them, so
 * the typecheck measures them and its key has to carry them too.
 */
const harnessSources = Smithers.glob("//apps/ui/scripts/**/*.ts")
const suiteSources = Smithers.glob("//apps/ui/e2e/**/*.ts")

/**
 * Projects the pinned Electrobun SDK before a fresh checkout can typecheck.
 * CI installs with scripts disabled, and the SDK is generated outside the
 * build cache, so this prerequisite always checks the local projection.
 *
 * @since 1.0.0-rc.0
 * @category build
 */
const devkit = Smithers.NodeBinary({
  entry: Smithers.file("scripts/ensure-devkit.mjs"),
  args: [],
  srcs: [
    Smithers.file("package.json"),
    Smithers.file("electrobun.config.ts"),
    Smithers.file("hutch.config.ts"),
    Smithers.file("//pnpm-lock.yaml")
  ],
  deps: [],
  env: { HUTCH_NO_UPDATE_CHECK: "1" },
  cwd
})

/**
 * Checks the application against its own tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  /*
   * Everything this tsconfig includes: `scripts`, `e2e`, and the bundler and
   * Electrobun configs are compiled by this target, so a key made of `src`
   * alone would serve a green cache entry over an edit that breaks the
   * typecheck.
   */
  srcs: [
    sources,
    componentSources,
    harnessSources,
    suiteSources,
    ...buildConfigs,
    Smithers.file("electrobun.config.ts"),
    Smithers.file("hutch.config.ts"),
    Smithers.file("playwright.config.ts")
  ],
  deps: [devkit],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The unit suite: everything under `src/`, hermetic, no server and no browser.
 *
 * @since 0.1.0
 * @category test
 */
// Coverage policy: assertion-only for Bun UI units, with required offline
// Playwright in browserE2e. No source coverage percentage is claimed; see
// scripts/repo-contract/README.md for the denominator exception.
const unitTests = Smithers.NodeTest({
  runtime: Smithers.Runtime.Bun({ version: ">=1.4.0" }),
  runner: Smithers.testSuite(["src"]),
  srcs: [sources, componentSources, styleSources],
  deps: [],
  cwd
})

/** Runs the actual pinned Playwright browser suite, with no live provider calls. */
const browserE2e = Smithers.NodeTest({
  runner: Smithers.entrypoint(Smithers.file("scripts/run-pr-e2e.mjs")),
  srcs: [sources, componentSources, styleSources, harnessSources, suiteSources, ...buildConfigs,
    Smithers.file("playwright.config.ts"), Smithers.file("package.json"), Smithers.file("//pnpm-lock.yaml")],
  deps: [],
  env: { SMITHERS_CHAT_STUB: "1" },
  cwd
})

export const Package = Smithers.Package({
  targets: { devkit, check, unitTests, browserE2e }
})
