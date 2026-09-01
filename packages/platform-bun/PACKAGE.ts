import { Smithers as S } from "@smthrs/targets"

const srcs = S.Filegroup({ srcs: [S.glob("src/**/*.ts")] })
const tests = S.Filegroup({ srcs: [S.glob("test/**/*.ts")] })
const tsconfig = S.file("tsconfig.json")
const testTsconfig = S.file("tsconfig.test.json")
const rootTsconfig = S.file("//tsconfig.base.json")
const cwd = "packages/platform-bun"

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

// The BunHostRedirect contract suite starts an HTTP server on 127.0.0.1 to
// serve the redirect chain it guards, which the default profile refuses with
// "listen EPERM", so the target declares the loopback profile. Egress stays
// denied.
const test = S.Shell.Test({
  bin: S.NodeModule.Bin("vitest"),
  args: ["run"],
  cwd,
  sandbox: { network: "loopback" },
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
// package's vitest suite re-run under Bun. Bun spawns the installed vitest
// entry file by path for two reasons. `bun x vitest` downloads the package
// manifest from the registry, and package-mode targets run with the network
// denied. `S.NodeModule.Bin("vitest")` resolves to the node_modules/.bin
// shim, which execs node, so it would turn this leg into a second Node run.
// Coverage stays off because @vitest/coverage-v8 needs V8's inspector and Bun
// runs JavaScriptCore, so `test` above remains the coverage gate.
//
// The host-redirect contract suite starts an HTTP server on 127.0.0.1, which
// the default profile refuses at bind time, so the target declares the
// loopback profile. Egress stays denied.
const bunTest = S.Shell.Test({
  bin: S.Host.bin("bun"),
  args: ["./node_modules/vitest/vitest.mjs", "run", "--environment", "node", "--coverage.enabled=false"],
  cwd,
  sandbox: { network: "loopback" },
  data: [srcs, tests, S.file("vitest.config.ts"), lib]
})

const ci = S.Suite({
  tests: [check, test, lint, fmt, circular, bunTest]
})

export const Package = S.Package({
  targets: { srcs, tests, lib, check, test, lint, fmt, circular, bunTest, ci }
})
