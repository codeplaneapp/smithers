/**
 * The two JavaScript-program targets: what argv each one renders, and which
 * verb each one participates in.
 *
 * These replaced the `node --test …` and `node scripts/….mjs` strings a
 * BUILD.ts file used to carry. The assertions that matter are the argv ones:
 * the interpreter comes from the declared runtime, so a workspace that switches
 * interpreters gets different argv from the same declaration.
 */
import { describe, expect, it } from "vitest"
import * as Input from "../src/Input.ts"
import * as NodeBinary from "../src/NodeBinary.ts"
import * as NodeTest from "../src/NodeTest.ts"
import * as Runtime from "../src/Runtime.ts"
import * as StandardPackage from "../src/StandardPackage.ts"
import * as Target from "../src/Target.ts"
import { packageManager, runtime } from "./toolchain.ts"

const bun = Runtime.Bun({ version: ">=1.3.0" })

const attrsOf = <A>(target: unknown): A => Target.metadata(target as never).attrs as A

describe("NodeTest", () => {
  it("runs declared test files through the runtime's own test runner", () => {
    const attrs = attrsOf<NodeTest.Attrs>(NodeTest.NodeTest({
      runtime,
      runner: NodeTest.testRunner([
        Input.file("//scripts/pack-release.test.mjs"),
        Input.file("//scripts/flows-backup.test.mjs")
      ]),
      srcs: [],
      deps: []
    }))
    expect(NodeTest.runArgv(attrs)).toEqual([
      "node",
      "--test",
      "scripts/pack-release.test.mjs",
      "scripts/flows-backup.test.mjs"
    ])
  })

  it("spells the test runner the way the declared runtime spells it", () => {
    const attrs = attrsOf<NodeTest.Attrs>(NodeTest.NodeTest({
      runtime: bun,
      runner: NodeTest.testRunner([Input.file("//scripts/pack-release.test.mjs")]),
      srcs: [],
      deps: []
    }))
    expect(NodeTest.runArgv(attrs)).toEqual(["bun", "test", "scripts/pack-release.test.mjs"])
    expect(Runtime.test(runtime, ["a.mjs"])).toEqual(["node", "--test", "a.mjs"])
    expect(Runtime.test(bun, ["a.mjs"])).toEqual(["bun", "test", "a.mjs"])
  })

  it("runs a whole suite by directory under the runtime's own runner", () => {
    // The shape of a package's unit gate: `bun test src`, `node --test src`.
    // The paths are filters relative to cwd; the declared srcs carry the key
    // material.
    const attrs = attrsOf<NodeTest.Attrs>(NodeTest.NodeTest({
      runtime: bun,
      runner: NodeTest.testSuite(["src", "scripts"]),
      srcs: [],
      deps: [],
      cwd: "apps/server"
    }))
    expect(NodeTest.runArgv(attrs)).toEqual(["bun", "test", "src", "scripts"])
    expect(attrs.cwd).toBe("apps/server")
    expect(NodeTest.runArgv(attrsOf<NodeTest.Attrs>(NodeTest.NodeTest({
      runtime,
      runner: NodeTest.testSuite(["src"]),
      srcs: [],
      deps: []
    })))).toEqual(["node", "--test", "src"])
  })

  it("runs an entry point with its declared arguments", () => {
    const attrs = attrsOf<NodeTest.Attrs>(NodeTest.NodeTest({
      runtime,
      runner: NodeTest.entrypoint(Input.file("//scripts/smoke-release.mjs"), ["dist/release-packs"]),
      srcs: [],
      deps: []
    }))
    expect(NodeTest.runArgv(attrs)).toEqual(["node", "scripts/smoke-release.mjs", "dist/release-packs"])
  })

  it("keeps a package-relative entry point relative to its cwd", () => {
    const attrs = attrsOf<NodeTest.Attrs>(NodeTest.NodeTest({
      runtime,
      runner: NodeTest.entrypoint(Input.file("scripts/circular.mjs")),
      srcs: [],
      deps: [],
      cwd: "packages/plan"
    }))
    expect(NodeTest.runArgv(attrs)).toEqual(["node", "scripts/circular.mjs"])
    expect(attrs.cwd).toBe("packages/plan")
  })

  /**
   * The runner is a discriminated union, so the fields one form does not have
   * are fields a BUILD.ts file cannot write: no argument list on a test-runner
   * run, no file list on an entry-point run, and never both.
   */
  it("refuses a runner that is neither form", () => {
    const declare = (runner: unknown): unknown =>
      NodeTest.NodeTest({ runtime, runner: runner as never, srcs: [], deps: [] })
    expect(() => declare({ name: "test-runner", tests: [] })).toThrow()
    expect(() => declare({ name: "suite", paths: [] })).toThrow()
    expect(() => declare({ name: "entrypoint" })).toThrow()
    expect(() => declare({ name: "shell", command: "node --test a.mjs" })).toThrow()
    // A field the chosen form does not have is a rejected declaration, so it
    // cannot smuggle an interpreter flag past the runner union.
    expect(() =>
      declare({
        name: "test-runner",
        tests: [Input.file("a.mjs")],
        args: ["--experimental-loader", "./evil.mjs"]
      })
    ).toThrow(/excess property/)
  })

  it("participates in the test verb alone", () => {
    expect(NodeTest.NodeTest.kinds).toEqual(["test"])
  })
})

describe("NodeBinary", () => {
  it("runs an entry point under the declared runtime, in the build verb", () => {
    const target = NodeBinary.NodeBinary({
      runtime,
      entry: Input.file("//scripts/pack-release.mjs"),
      args: ["dist/release-packs"],
      srcs: [],
      deps: []
    })
    expect(NodeBinary.runArgv(attrsOf<NodeBinary.Attrs>(target)))
      .toEqual(["node", "scripts/pack-release.mjs", "dist/release-packs"])
    expect(NodeBinary.NodeBinary.kinds).toEqual(["build"])
    // Its product is written through tools the build system does not own, so a
    // stored result would not identify what produced it.
    expect(Target.metadata(target as never).cacheable).toBe(false)
  })

  it("passes a declared environment to the run", () => {
    const attrs = attrsOf<NodeBinary.Attrs>(NodeBinary.NodeBinary({
      runtime,
      entry: Input.file("//crates/flows-jj/build-wasm.mjs"),
      args: [],
      srcs: [],
      deps: [],
      env: { CARGO_TARGET_DIR: "target/scratch" }
    }))
    expect(attrs.env).toEqual({ CARGO_TARGET_DIR: "target/scratch" })
  })
})

describe("StandardPackage circular guard", () => {
  /**
   * `pnpm run circular` fanned out to a per-package script the target graph did
   * not know about, so `smthrs ci` was not gate-equivalent to the pnpm scripts
   * it was meant to replace. The macro emits it now.
   */
  it("emits the conventional per-package circular-dependency guard", () => {
    const targets = StandardPackage.StandardPackage({ packageManager, cwd: "packages/plan" })
    const attrs = attrsOf<NodeTest.Attrs>(targets.circular)
    expect(NodeTest.runArgv(attrs)).toEqual(["node", "scripts/circular.mjs"])
    expect(attrs.cwd).toBe("packages/plan")
    // The interpreter is the one the declared manager runs under, not a
    // hardcoded `node`.
    expect(attrs.runtime).toEqual(packageManager.runtime)
  })

  it("takes another guard when a package keeps one elsewhere", () => {
    const targets = StandardPackage.StandardPackage({
      packageManager,
      cwd: "packages/plan",
      circularScript: Input.file("tools/cycles.mjs")
    })
    expect(NodeTest.runArgv(attrsOf<NodeTest.Attrs>(targets.circular)))
      .toEqual(["node", "tools/cycles.mjs"])
  })
})
