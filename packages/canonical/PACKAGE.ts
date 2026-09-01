// Package-mode port of the check surface BUILD-era PackageDefaults
// synthesized for this package (root BUILD.ts `packageDefaults` +
// packages/targets/src/StandardPackage.ts): lib, check, test, lint, fmt,
// circular, re-expressed in the executable PACKAGE.ts vocabulary. The
// synthesized DocsParity `docs` target has no package-mode rule yet; the
// wave-2 contract in docs/migration/package-mode-port.md records the gap.
import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({ srcs: [S.glob("src/**/*.ts")] })
const tests = S.Filegroup({ srcs: [S.glob("test/**/*.ts")] })
const tsconfig = S.file("tsconfig.json")
const testTsconfig = S.file("tsconfig.test.json")
const rootTsconfig = S.file("//tsconfig.base.json")

// StandardPackage's `lib` is a dual-format TsBuild into dist/. The package
// scripts/build.mjs is what the pnpm build script runs; it stays the one
// build path.
const lib = S.Shell.Build({
  script: S.file("scripts/build.mjs"),
  data: [srcs, tsconfig, rootTsconfig, S.file("package.json")],
  outDirs: ["dist"]
})

// StandardPackage `check`: tsc -p tsconfig.test.json --noEmit, after lib so
// workspace dependents resolve through built declarations.
// A shell target spawns from the workspace root, and eslint, dprint, and
// vitest each resolve their configuration and ignore globs against the working
// directory. `cwd` names this package so each tool reads its own config, the
// way the BUILD-era rules did.
const cwd = "packages/canonical"

const check = S.Shell.Test({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: ["-p", "tsconfig.test.json", "--noEmit"],
  cwd,
  data: [srcs, tests, testTsconfig, tsconfig, rootTsconfig, lib]
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

// The Bun leg of the runtime-compatibility matrix ci/BUILD.ts owns: this
// package's vitest suite re-run under Bun. `--root` carries that target's
// `cwd`, because package-mode Shell targets always spawn from the workspace
// root. Coverage stays off because @vitest/coverage-v8 needs V8's inspector
// and Bun runs JavaScriptCore, so `test` above remains the coverage gate.
const bunTest = S.Shell.Test({
  bin: S.Host.bin("bun"),
  args: ["x", "vitest", "run", "--root", "packages/canonical", "--environment", "node", "--coverage.enabled=false"],
  data: [srcs, tests, S.file("vitest.config.ts"), lib]
})

const ci = S.Suite({
  tests: [check, test, lint, fmt, circular, bunTest]
})

export const Package = S.Package({
  targets: { srcs, tests, lib, check, test, lint, fmt, circular, bunTest, ci }
})
