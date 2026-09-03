/**
 * Targets for the retained Smithers 0.x component kit.
 *
 * This directory is one of two under `packages/` that the 1.0 migration kept
 * unchanged rather than replaced: the imported product UI (`apps/ui`) imports
 * `@smthrs/ui`, so Phase 1 left it in place (`docs/migration/disposition-ledger.md`,
 * row `packages/ui`, disposition `keep`).
 *
 * Its presence here is what this file is for. The root `packageDefaults`
 * synthesizes `StandardPackage` — a dual `dist/esm` and `dist/cjs` library
 * build, a vitest
 * suite at 100% coverage, eslint, and dprint — for every `packages/*`
 * directory that ships no `PACKAGE.ts` of its own. This package satisfies none of
 * that: it ships its sources directly, types against `@types/bun`, and tests
 * with `bun test`. Declaring the targets it can honor opts it out of the
 * synthesis (`PackageDefaults` skips a directory holding a `PACKAGE.ts`) and puts
 * its real gates in the graph instead of targets that cannot pass.
 *
 * Two of the four standard gates are honored here: the `bun test` suite and a
 * `tsc --noEmit` typecheck over `src/`. The eslint and dprint halves are NOT
 * declared, because this package carries neither an `eslint.config.js` nor a
 * `dprint.json` and both tools are per-package devDependencies elsewhere in the
 * workspace; wiring them is a manifest change that belongs to the port below,
 * not to a gate declaration.
 *
 * The Phase 4 UI port rewrites this package onto the 1.0 baseline. That port
 * deletes this file and lets the defaults apply.
 */
import { Smithers } from "@smthrs/targets"
import { bunRuntime, packageManager } from "../../PACKAGE.ts"

const cwd = "packages/ui"

/** The component sources the suite drives. */
const sources = [
  Smithers.glob("//packages/ui/src/**/*.ts"),
  Smithers.glob("//packages/ui/src/**/*.tsx")
]

/**
 * Checks every component source against the package tsconfig.
 *
 * The package publishes its `src/` tree directly (`files: ["src/"]`, every
 * export condition points at a `.ts`/`.tsx` source), so this typecheck is the
 * only thing standing between a type error and a consumer's build. Root
 * `pnpm run check` reaches it through the package's own `check` script.
 *
 * @since 0.1.0
 * @category build
 */
const check = Smithers.Typecheck({
  packageManager,
  srcs: sources,
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The component suite: everything under `tests/`, run by Bun against a
 * happy-dom registrator, which is how this package has always tested.
 *
 * @since 0.1.0
 * @category test
 */
const unitTests = Smithers.NodeTest({
  runtime: bunRuntime,
  runner: Smithers.testSuite(["tests"]),
  srcs: [
    ...sources,
    Smithers.glob("//packages/ui/tests/**/*.ts"),
    Smithers.glob("//packages/ui/tests/**/*.tsx")
  ],
  deps: [],
  cwd
})

export const Package = Smithers.Package({
  targets: { check, unitTests }
})
