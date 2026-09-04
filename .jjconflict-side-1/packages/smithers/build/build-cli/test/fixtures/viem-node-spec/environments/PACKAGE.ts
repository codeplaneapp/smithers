/// <reference path="../smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"
import { Package as src } from "../src/PACKAGE.js"

// One file covers the five environment packages (bun, next, node, tsc,
// vite). Each is a minimal consumer app that installs the built package
// and runs a smoke test in that runtime; next and vite drive a browser
// through playwright. runtime: overrides the workspace default per target,
// so the CI runtime matrix (bun, node 22, node latest) is data, not YAML.
const envTest = (name: string, runtime?: SmithersValue) => {
  return S.Shell.Test({
    bin: S.PackageManager.bin,
    args: ["--filter", `test-${name}`, "test"],
    data: [S.Filegroup({ srcs: S.glob([`${name}/**`]) }), src.build],
    runtime,
  })
}

const testBun = envTest("bun", S.Runtime.Bun({ version: "1.0.30" }))

const testNode22 = envTest("node", S.Runtime.Node({ version: "22" }))

const testNodeLatest = envTest("node", S.Runtime.Node({ version: "latest" }))

const testNext = envTest("next")

const testTsc = envTest("tsc", S.Runtime.Node({ version: "22" }))

const testVite = envTest("vite")

const envs = S.Suite({
  tests: [testBun, testNode22, testNodeLatest, testNext, testTsc, testVite],
})

export const Package = S.Package({
  targets: {
    envs,
    testBun,
    testNext,
    testNode22,
    testNodeLatest,
    testTsc,
    testVite,
  },
})
