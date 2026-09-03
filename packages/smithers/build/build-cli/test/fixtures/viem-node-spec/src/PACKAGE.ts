/// <reference path="../smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"

const packageJson = S.file("package.json")
const buildTsconfig = S.file("//tsconfig.build.json")
const baseTsconfig = S.file("//tsconfig.base.json")

const srcs = S.Filegroup({
  srcs: S.glob([
    "**",
    "!**/*.test.ts",
    "!**/*.test-d.ts",
    "!**/*.bench.ts",
    "!**/*.bench-d.ts",
    "!_cjs/**",
    "!_esm/**",
    "!_types/**",
  ]),
})

// Tests are colocated with the source; the vitest projects in
// //test:PACKAGE.ts consume this group.
const tests = S.Filegroup({
  srcs: S.glob(["**/*.test.ts", "**/*.test-d.ts", "**/*.bench.ts", "**/*.bench-d.ts"]),
})

// The CJS emit needs a different trustedSetups implementation. Upstream
// swaps the file with mv before and after the compile
// (build:trustedSetups:start/end). Overlay is a derived filegroup with one
// member substituted, so the CJS build compiles the right file without
// mutating the tree.
const cjsSources = S.Overlay({
  base: srcs,
  replace: { "node/trustedSetups.ts": S.file("node/trustedSetups_cjs.ts") },
})

// Literal materializes a fixed file, replacing the printf > package.json
// stamps in the build scripts.
const esmStamp = S.Literal({
  path: "_esm/package.json",
  content: '{"type":"module","sideEffects":false}',
})

const cjsStamp = S.Literal({
  path: "_cjs/package.json",
  content: '{"type":"commonjs"}',
})

const typesStamp = S.Literal({
  path: "_types/package.json",
  content: '{"type":"module"}',
})

const compileEsm = S.Shell.Build({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: ["--project", "tsconfig.build.json", "--outDir", "./src/_esm"],
  data: [srcs, buildTsconfig, baseTsconfig],
  outDirs: ["_esm"],
})

const buildEsm = S.Filegroup({
  srcs: [compileEsm, esmStamp],
})

// Upstream wraps tsc in scripts/runTsc.js only to pass CLI overrides; the
// rule passes them directly.
const compileCjs = S.Shell.Build({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: [
    "--project", "tsconfig.build.json",
    "--module", "commonjs",
    "--moduleResolution", "node",
    "--outDir", "./src/_cjs",
    "--removeComments",
    "--verbatimModuleSyntax", "false",
  ],
  data: [cjsSources, buildTsconfig, baseTsconfig],
  outDirs: ["_cjs"],
})

const buildCjs = S.Filegroup({
  srcs: [compileCjs, cjsStamp],
})

const compileTypes = S.Shell.Build({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  args: [
    "--project", "tsconfig.build.json",
    "--declarationDir", "./src/_types",
    "--emitDeclarationOnly",
    "--declaration",
    "--declarationMap",
    "--incremental", "false",
  ],
  data: [srcs, buildTsconfig, baseTsconfig],
  outDirs: ["_types"],
})

const buildTypes = S.Filegroup({
  srcs: [compileTypes, typesStamp],
})

// The publishable package: the three emits the exports map in
// src/package.json points at.
const build = S.Filegroup({
  srcs: [buildEsm, buildCjs, buildTypes],
})

// version:update writes the package version into errors/version.ts so
// runtime error URLs carry it.
const version = S.Generate({
  bin: S.NodeModule.Bin("bun"),
  args: ["scripts/updateVersion.ts"],
  data: [packageJson],
  changes: ["errors/version.ts"],
})

// gen:tempo-abis derives ABI and selector tables plus a test fixture.
// changes uses absolute labels because the generator writes across
// packages.
const tempoAbis = S.Generate({
  bin: S.NodeModule.Bin("bun"),
  args: ["scripts/generateTempoAbis.ts"],
  data: [srcs],
  changes: [
    "//src/tempo/Abis.ts",
    "//src/tempo/Selectors.ts",
    "//test/src/tempo/earnContracts.ts",
  ],
})

// gen:tokenlist fetches the upstream token list, so the generator is one
// of the few network targets outside tests.
const tokenlist = S.Generate({
  bin: S.NodeModule.Bin("bun"),
  args: ["scripts/generateTokenlist.ts"],
  data: [srcs],
  changes: ["tokens/**"],
  sandbox: { network: true },
})

export const Package = S.Package({
  targets: {
    build,
    buildCjs,
    buildEsm,
    buildTypes,
    srcs,
    tempoAbis,
    tests,
    tokenlist,
    version,
  },
})
