/**
 * Standard package targets, plus the templates' own suites.
 *
 * The package had none, so none of its gates ran in CI: the workflow runs
 * `smithers-build ci '//packages/...'` and never `pnpm -r test`, and a gate
 * becomes a target in the package that owns it before CI can run it. Its
 * router is the code that decides what a scaffolded app routes, so a silent
 * regression there is a wrong route table in every app cut from this checkout.
 *
 * `cwd` anchors every emitted tool run in this package directory. There is no
 * documentation-generation target: the package is private at 1.0.0-rc.0 and
 * owns no page under `docs/pages`, so its prose lives in `docs/` and is
 * published by hand review rather than by a generator. `docs/README.md`
 * records what to add when that changes, and `test/docsParity.test.ts` is what
 * keeps the hand-written page honest until then.
 */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/create-app"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = Smithers.StandardPackage({
  deps: [],
  cwd
})

/**
 * The shipped templates' own suites.
 *
 * A template is a whole app rather than a source tree of this package, so its
 * tests are not in `test/**` and `vitest.config.ts` does not include them. That
 * put every test for the scaffolded Worker's credential check, body cap,
 * session-id rule, settle-once stream wrapper and turn cancellation outside
 * every gate. `vitest.template.config.ts` runs them from this package against
 * workspace sources, and its docstring records what that resolves and what it
 * cannot: the templates' `tsc --noEmit` needs an install and stays a scaffolded
 * app's `pnpm typecheck`.
 *
 * The declared sources are what the suites actually import — the template
 * trees plus this package's `src` behind the `@smthrs/create-app/*` aliases —
 * so an edit to either re-runs the target rather than reporting a cache hit.
 *
 * @since 0.1.0
 * @category test
 */
const templates = Smithers.Vitest({
  tests: [Smithers.glob("template/*/test/**/*.test.ts")],
  sources: [
    Smithers.glob("src/**/*.ts"),
    Smithers.glob("test/support/**/*.ts"),
    Smithers.glob("template/**/*.ts"),
    Smithers.glob("template/**/*.tsx"),
    Smithers.glob("template/**/*.json")
  ],
  deps: [],
  config: Smithers.file("vitest.template.config.ts"),
  environment: "node",
  // The thresholds in `vitest.config.ts` are measured over `src/**` by the
  // package's own suite. This run's subject is the templates, so it computes
  // no coverage rather than reporting a second, lower number for the same
  // files.
  coverage: false,
  passWithNoTests: false,
  cwd
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, templates, test }
})
