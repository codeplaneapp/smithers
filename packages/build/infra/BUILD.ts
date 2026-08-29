/**
 * Targets for the remote-cache infrastructure workspace.
 *
 * This directory is a workspace package (`packages/build/infra` in
 * `pnpm-workspace.yaml`) but not a `packages/*` directory, so the standard
 * package defaults never match it and `//packages/...` planned nothing here.
 * `pnpm run check` and `pnpm test` used to reach it only through the recursive
 * root scripts; these targets are the same gates as declarations.
 */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../../BUILD.ts"

const cwd = "packages/build/infra"

/** The worker, its migrations, and the operator scripts the gates read. */
const sources = [
  Smithers.glob("//packages/build/infra/worker/**/*.ts"),
  Smithers.glob("//packages/build/infra/scripts/**/*.ts"),
  Smithers.file("alchemy.run.ts"),
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
export const check = Smithers.Typecheck({
  packageManager,
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
export const suite = Smithers.Vitest({
  packageManager,
  tests: [Smithers.glob("//packages/build/infra/worker/test/**/*.ts")],
  sources,
  deps: [],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})
