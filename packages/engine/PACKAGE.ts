import { Smithers as S } from "@smthrs/targets"
import { Package as flow } from "../flow/PACKAGE.js"

const srcs = S.Filegroup({ srcs: [S.glob("src/**/*.ts")] })
const tests = S.Filegroup({ srcs: [S.glob("test/**/*.ts")] })
const tsconfig = S.file("tsconfig.json")
const testTsconfig = S.file("tsconfig.test.json")
const rootTsconfig = S.file("//tsconfig.base.json")
const cwd = "packages/engine"

const lib = S.Shell.Build({
  script: S.file("scripts/build.mjs"),
  data: [srcs, tsconfig, rootTsconfig, S.file("package.json"), flow.lib],
  outDirs: ["dist"]
})

const check = S.Shell.Test({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: ["-p", "tsconfig.test.json", "--noEmit"],
  cwd,
  data: [srcs, tests, testTsconfig, tsconfig, rootTsconfig, lib, flow.lib]
})

// FlowProxyServer.test.ts serves the API on a real listener through
// NodeHttpServer.layerTest, which passes `{ port: 0 }` with no host, so Node
// binds the wildcard address rather than 127.0.0.1. The loopback profile
// still admits that bind and the client's loopback connect back to it, so
// the wildcard does not force `{ network: true }`; egress stays denied.
const test = S.Shell.Test({
  bin: S.NodeModule.Bin("vitest"),
  args: ["run"],
  cwd,
  sandbox: { network: "loopback" },
  data: [srcs, tests, S.file("vitest.config.ts"), lib, flow.lib]
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

// Knip accepts dependency ignores only through a config file.
const dependencyPolicy = S.Shell.Test({
  bun: "const fs = await import('node:fs/promises')\n" +
    "const os = await import('node:os')\n" +
    "const path = await import('node:path')\n" +
    "const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'smithers-knip-'))\n" +
    "const config = path.join(directory, 'knip.json')\n" +
    "await Bun.write(config, JSON.stringify({ ignoreDependencies: ['eslint-plugin-jsdoc'] }))\n" +
    "let exitCode = 0\n" +
    "try { exitCode = Bun.spawnSync({ cmd: [knip, '--dependencies', '--config', config], cwd: 'packages/engine', stdout: 'inherit', stderr: 'inherit' }).exitCode } finally { await fs.rm(directory, { recursive: true, force: true }) }\n" +
    "if (exitCode !== 0) process.exit(exitCode)",
  using: { knip: S.NodeModule.Bin("knip") },
  data: [srcs, tests, S.file("package.json"), lib]
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
// FlowProxyServer.test.ts serves a real HTTP listener on 127.0.0.1, which the
// default profile refuses at bind time, so the target declares the loopback
// profile. Egress stays denied.
const bunTest = S.Shell.Test({
  bin: S.Host.bin("bun"),
  args: ["./node_modules/vitest/vitest.mjs", "run", "--environment", "node", "--coverage.enabled=false"],
  cwd,
  sandbox: { network: "loopback" },
  data: [srcs, tests, S.file("vitest.config.ts"), lib, flow.lib]
})

const ci = S.Suite({
  tests: [check, test, lint, fmt, circular, dependencyPolicy, bunTest]
})

export const Package = S.Package({
  targets: { srcs, tests, lib, check, test, lint, fmt, circular, dependencyPolicy, bunTest, ci }
})
