import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({ srcs: [S.glob("src/**/*.ts")] })
const tests = S.Filegroup({ srcs: [S.glob("test/**/*.ts")] })
const tsconfig = S.file("tsconfig.json")
const testTsconfig = S.file("tsconfig.test.json")
const rootTsconfig = S.file("//tsconfig.base.json")

// This private package has no distribution; BUILD.ts's lib is compile-only.
const lib = S.Shell.Test({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: ["-p", "tsconfig.json", "--noEmit"],
  data: [srcs, tsconfig, rootTsconfig]
})

const check = S.Shell.Test({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: ["-p", "tsconfig.test.json", "--noEmit"],
  data: [srcs, tests, testTsconfig, tsconfig, rootTsconfig, lib]
})

const test = S.Shell.Test({
  bin: S.NodeModule.Bin("vitest"),
  args: ["run"],
  data: [srcs, tests, S.file("vitest.config.ts"), lib]
})

const lint = S.Shell.Test({
  bin: S.NodeModule.Bin("eslint"),
  args: ["--max-warnings", "0", "src"],
  data: [srcs, S.file("eslint.config.js"), S.file("//eslint.jsdoc.js")]
})

const fmt = S.Shell.Test({
  bin: S.NodeModule.Bin("dprint"),
  args: ["check"],
  data: [srcs, tests, S.file("dprint.json")]
})

const circular = S.Shell.Test({
  script: S.file("scripts/circular.mjs"),
  data: [srcs]
})

const ci = S.Suite({
  tests: [lib, check, test, lint, fmt, circular]
})

export const Package = S.Package({
  targets: { srcs, tests, lib, check, test, lint, fmt, circular, ci }
})
