/**
 * Targets for the remote-cache infrastructure workspace.
 *
 * This directory is a workspace package (`packages/smithers/build/infra` in
 * `pnpm-workspace.yaml`) but not a `packages/*` directory, so the standard
 * package defaults never match it and `//packages/...` planned nothing here.
 * `pnpm run check` and `pnpm test` used to reach it only through the recursive
 * root scripts; these targets are the same gates as declarations.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/build/infra"

/**
 * The worker, its migrations, and the operator scripts the gates read.
 *
 * The migrations are declared inputs because they are the production D1
 * schema and `worker/test/migrations.test.ts` executes them: without them a
 * schema change leaves the target key unchanged and the suite reports green
 * on a stale remote-cache hit. `PACKAGE.ts` and `vitest.config.ts` are declared
 * for the same reason, since `tsconfig.node.json` typechecks both.
 */
const sources = [
  Smithers.glob("//packages/smithers/build/infra/worker/**/*.ts"),
  Smithers.glob("//packages/smithers/build/infra/worker/migrations/**/*.sql"),
  Smithers.glob("//packages/smithers/build/infra/scripts/**/*.ts"),
  Smithers.file("alchemy.run.ts"),
  Smithers.file("deployment.ts"),
  Smithers.file("PACKAGE.ts"),
  Smithers.file("vitest.config.ts"),
  Smithers.file("tsconfig.worker.json"),
  Smithers.file("tsconfig.node.json"),
  Smithers.file("tsconfig.test.json")
]

/**
 * Checks the workspace against its own tsconfig.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  srcs: sources,
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: true,
  incremental: false,
  cwd
})

/**
 * Runs the worker protocol, migration, and redaction suites.
 *
 * @since 0.1.0
 * @category test
 */
const suite = Smithers.Vitest({
  tests: [
    Smithers.glob("//packages/smithers/build/infra/worker/test/**/*.ts"),
    Smithers.glob("//packages/smithers/build/infra/scripts/**/*.test.ts")
  ],
  sources,
  deps: [],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

/**
 * Lints the worker and the operator scripts.
 *
 * `packages/smithers/build/eslint.config.js` has configured `infra/**` since this
 * directory was imported, but nothing ran it: the parent package's `lint`
 * target takes the standard `src/**` glob, so these files reached ESLint
 * only by hand. The target runs from `packages/smithers/build` so the flat config's
 * relative `files` patterns and `tsconfigRootDir` resolve.
 *
 * @since 0.1.0
 * @category lint
 */
const lint = Smithers.EsLint({
  sources: [Smithers.glob("infra/**/*.ts")],
  deps: [],
  configs: [
    Smithers.file("eslint.config.js"),
    Smithers.file("//eslint.jsdoc.js"),
    Smithers.file("//eslint.invariants.js")
  ],
  maxWarnings: 0,
  fix: false,
  cwd: "packages/smithers/build"
})

/**
 * Checks that the deployment documents itself beside its code.
 *
 * @since 0.1.0
 * @category docs
 */
const docs = Smithers.DocsParity({
  readme: Smithers.file("README.md"),
  deps: [],
  cwd
})

export const Package = Smithers.Package({
  targets: { check, docs, lint, suite }
})
