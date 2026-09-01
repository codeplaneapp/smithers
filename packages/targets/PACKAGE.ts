// Package-mode port of packages/targets/BUILD.ts. This package ships no
// distribution (its tsconfig sets noEmit), so the BUILD-era `lib` Typecheck
// stays a compile-only gate here: Shell.Test over tsc, per the rule
// translation table in docs/migration/package-mode-port.md.
import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({ srcs: [S.glob("src/**/*.ts")] })
const tests = S.Filegroup({ srcs: [S.glob("test/**/*.ts")] })
const rootTsconfig = S.file("//tsconfig.base.json")
const cwd = "packages/targets"

// BUILD-era `lib`: Typecheck over tsconfig.json (noEmit already set there).
const lib = S.Shell.Test({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: ["-p", "tsconfig.json", "--noEmit"],
  cwd,
  data: [srcs, S.file("tsconfig.json"), rootTsconfig]
})

// BUILD-era `check`: the test program, tsconfig.test.json, after lib.
const check = S.Shell.Test({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: ["-p", "tsconfig.test.json", "--noEmit"],
  cwd,
  data: [srcs, tests, S.file("tsconfig.test.json"), S.file("tsconfig.json"), rootTsconfig, lib]
})

const test = S.Shell.Test({
  bin: S.NodeModule.Bin("vitest"),
  args: ["run"],
  cwd,
  data: [srcs, tests, S.file("vitest.config.ts"), lib]
})

const lint = S.Shell.Test({
  bin: S.NodeModule.Bin("eslint"),
  args: ["--max-warnings", "0", "src"],
  cwd,
  data: [srcs, S.file("eslint.config.js"), S.file("//eslint.jsdoc.js")]
})

const fmt = S.Shell.Test({
  bin: S.NodeModule.Bin("dprint"),
  args: ["check"],
  cwd,
  data: [srcs, tests, S.file("dprint.json")]
})

const circular = S.Shell.Test({
  script: S.file("scripts/circular.mjs"),
  cwd,
  data: [srcs]
})

const ci = S.Suite({
  tests: [lib, check, test, lint, fmt, circular]
})

export const Package = S.Package({
  targets: { srcs, tests, lib, check, test, lint, fmt, circular, ci }
})
