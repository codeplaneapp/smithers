import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({ srcs: [S.glob("src/**/*.ts")] })
const tests = S.Filegroup({ srcs: [S.glob("test/**/*.ts")] })
const tsconfig = S.file("tsconfig.json")
const testTsconfig = S.file("tsconfig.test.json")
const rootTsconfig = S.file("//tsconfig.base.json")
const cwd = "packages/observability"

const lib = S.Shell.Build({
  script: S.file("scripts/build.mjs"),
  data: [srcs, tsconfig, rootTsconfig, S.file("package.json")],
  outDirs: ["dist"]
})

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

const ci = S.Suite({
  tests: [check, test, lint, fmt, circular]
})

export const Package = S.Package({
  targets: { srcs, tests, lib, check, test, lint, fmt, circular, ci }
})
