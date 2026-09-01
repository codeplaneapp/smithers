/**
 * Standard package targets for a private, unbuilt package.
 *
 * This package ships no distribution: it is `private: true`, its `bin` runs
 * `src/main.js` directly, and its tsconfig sets `noEmit`, so the synthesized
 * TsBuild `lib` target could never produce the `dist` tree it declares. `lib`
 * is therefore a Typecheck over the package tsconfig — the same compiler run
 * the build would perform, minus the emit — and keeps the conventional label
 * so dependents and the default-target convention are unchanged.
 *
 * The tsconfig used to declare `outDir`, `declaration`, and `declarationMap`
 * with no `noEmit` anywhere, so `pnpm check` wrote a real `dist/esm` tree and
 * the sentence above was simply false; `package.json` also carried a
 * `publishConfig` pointing at `dist/esm` and `dist/cjs` trees no target built.
 * Both are gone.
 */
import { Smithers } from "@smthrs/targets"
import { packageManager, rootInvariantsConfig, rootJSDocConfig, runtime } from "../../BUILD.ts"

const cwd = "packages/build-cli"
const sources = Smithers.glob("src/**/*.ts")
const tests = Smithers.glob("test/**/*.test.ts")

/**
 * The workspace trees the suites load: PACKAGE.ts and WORKSPACE.ts fixtures,
 * their goldens, and the checked-in files the render suites compare against.
 *
 * They are behavioural input to `PackageExecution`, `MultiRepo`, and the
 * CI-render suites, so they belong in the test target's key. Without them,
 * editing a fixture left the key unchanged and the run reported a cache hit
 * on a result that predated the edit.
 */
const fixtures = Smithers.glob("test/fixtures/**/*")

export const lib = Smithers.Typecheck({
  packageManager,
  srcs: [sources],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

export const check = Smithers.Typecheck({
  packageManager,
  srcs: [sources, Smithers.glob("test/**/*.ts")],
  deps: [lib],
  tsconfig: Smithers.file("tsconfig.test.json"),
  buildMode: false,
  incremental: false,
  cwd
})

export const test = Smithers.Vitest({
  packageManager,
  tests: [tests],
  sources: [sources, fixtures],
  deps: [lib],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

export const lint = Smithers.EsLint({
  packageManager,
  sources: [sources],
  deps: [],
  configs: [Smithers.file("eslint.config.js"), rootJSDocConfig, rootInvariantsConfig],
  maxWarnings: 0,
  fix: false,
  cwd
})

export const fmt = Smithers.Dprint({
  packageManager,
  sources: [sources, Smithers.glob("test/**/*.ts")],
  deps: [],
  config: Smithers.file("dprint.json"),
  fix: false,
  cwd
})

export const docs = Smithers.DocsParity({
  readme: Smithers.file("README.md"),
  deps: [],
  cwd
})

/**
 * The package's circular-dependency guard, run under the declared runtime.
 *
 * @since 0.1.0
 * @category test
 */
export const circular = Smithers.NodeTest({
  runtime,
  runner: Smithers.entrypoint(Smithers.file("scripts/circular.mjs")),
  srcs: [sources],
  deps: [],
  cwd
})
