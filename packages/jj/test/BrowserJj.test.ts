/**
 * `BrowserJj` against a hand-assembled wasm module speaking the frozen ABI.
 *
 * The real `flows_jj.wasm` cannot be scripted into every response shape, so —
 * exactly like `NodeJjClassification` scripts a fake `jj` binary — these tests
 * bake canned responses into a tiny wasm module and drive the layer end to
 * end through real `WebAssembly` instantiation. The module echoes each request
 * to fd 2, so the shim's stderr sink doubles as the assertion channel for what
 * the layer serialized. The real artifact is exercised by
 * `BrowserJjContract.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as fs from "node:fs"
import * as BrowserJj from "../src/browser/BrowserJj.ts"
import { isJjError, Jj, type JjError, type JjFailure } from "../src/Jj.ts"
import { emptyWasmModule, fakeFlowsJjWasm } from "./FakeFlowsJjWasm.ts"

/** The fake module never touches the filesystem; any structural slice will do. */
const slice = fs

/**
 * `Jj`'s error channel is `JjFailure` because the capability kernel decorates
 * the very same tag; an undecorated host layer can only ever produce the
 * `JjError` half, so narrow rather than widen every assertion.
 */
const jjError = (error: JjFailure): JjError => {
  if (!isJjError(error)) throw new Error(`expected a JjError from an undecorated host layer, got ${error._tag}`)
  return error
}

const run = <A>(options: BrowserJj.BrowserJjOptions, effect: (jj: Jj) => Effect.Effect<A, JjFailure>) =>
  Effect.provide(Effect.flatMap(Jj, effect), BrowserJj.layer(options))

const flip = (
  options: BrowserJj.BrowserJjOptions,
  effect: (jj: Jj) => Effect.Effect<unknown, JjFailure>
) => Effect.provide(Effect.map(Effect.flip(Effect.flatMap(Jj, effect)), jjError), BrowserJj.layer(options))

/** Every string field any operation extracts, so one module serves all six. */
const OK_ALL = "{\"ok\":{\"changeId\":\"qpvuntsm\",\"diff\":\"diff --git\",\"status\":\"clean\"}}"

describe("BrowserJj over the fake ABI module", () => {
  it.effect("instantiates lazily, runs _initialize once, and reuses the instance", () =>
    Effect.gen(function*() {
      const stderr: Array<string> = []
      const options: BrowserJj.BrowserJjOptions = {
        wasm: fakeFlowsJjWasm({ response: "{\"ok\":{\"status\":\"clean\"}}" }),
        fs: slice,
        onStderr: (text) => stderr.push(text)
      }
      const jj = yield* (Effect.provide(Jj, BrowserJj.layer(options)))
      expect(stderr).toEqual([]) // nothing instantiated until the first operation
      expect(yield* (jj.status())).toBe("clean")
      expect(yield* (jj.status())).toBe("clean")
      expect(stderr).toHaveLength(3)
      expect(stderr[0]).toBe("INIT")
      expect(JSON.parse(stderr[1]!)).toEqual({ op: "status", root: "/" }) // root defaults to "/"
      expect(JSON.parse(stderr[2]!)).toEqual({ op: "status", root: "/" })
    }))

  it.effect("serializes the frozen request shape for every operation", () =>
    Effect.gen(function*() {
      const stderr: Array<string> = []
      const options: BrowserJj.BrowserJjOptions = {
        wasm: fakeFlowsJjWasm({ response: OK_ALL }),
        fs: slice,
        root: "/repo",
        onStdout: () => {},
        onStderr: (text) => stderr.push(text)
      }
      const jj = yield* (Effect.provide(Jj, BrowserJj.layer(options)))
      expect(yield* (jj.snapshot("checkpoint"))).toEqual({ changeId: "qpvuntsm" })
      expect(yield* (jj.snapshot())).toEqual({ changeId: "qpvuntsm" })
      yield* (jj.restore("qpvuntsm"))
      expect(yield* (jj.diff("qpvuntsm", "zzzzzzzz"))).toBe("diff --git")
      yield* (jj.workspaceAdd("lane", "/lane1"))
      yield* (jj.workspaceForget("lane"))
      expect(yield* (jj.status())).toBe("clean")
      expect(stderr.slice(1).map((request) => JSON.parse(request))).toEqual([
        { op: "snapshot", root: "/repo", message: "checkpoint" },
        { op: "snapshot", root: "/repo" },
        { op: "restore", root: "/repo", changeId: "qpvuntsm" },
        { op: "diff", root: "/repo", from: "qpvuntsm", to: "zzzzzzzz" },
        { op: "workspaceAdd", root: "/repo", name: "lane", path: "/lane1" },
        { op: "workspaceForget", root: "/repo", name: "lane" },
        { op: "status", root: "/repo" }
      ])
    }))

  it.effect("pins a revisioned workspace add with a restore rooted at the new lane", () =>
    Effect.gen(function*() {
      const stderr: Array<string> = []
      const options: BrowserJj.BrowserJjOptions = {
        wasm: fakeFlowsJjWasm({ response: OK_ALL }),
        fs: slice,
        root: "/repo",
        onStderr: (text) => stderr.push(text)
      }
      const jj = yield* (Effect.provide(Jj, BrowserJj.layer(options)))
      yield* (jj.workspaceAdd("lane", "/lane1", "qpvuntsm"))
      // The frozen ABI has no revision field on `workspaceAdd`, so the pin is
      // the add followed by a restore rooted at the NEW lane's path — the
      // parent's tree is never touched.
      expect(stderr.slice(1).map((request) => JSON.parse(request))).toEqual([
        { op: "workspaceAdd", root: "/repo", name: "lane", path: "/lane1" },
        { op: "restore", root: "/lane1", changeId: "qpvuntsm" }
      ])
    }))

  it.effect("serializes concurrent operations through the semaphore", () =>
    Effect.gen(function*() {
      const stderr: Array<string> = []
      const options: BrowserJj.BrowserJjOptions = {
        wasm: fakeFlowsJjWasm({ response: "{\"ok\":{\"status\":\"clean\"}}" }),
        fs: slice,
        onStderr: (text) => stderr.push(text)
      }
      const results = yield* run(
        options,
        (jj) => Effect.all([jj.status(), jj.status(), jj.status()], { concurrency: "unbounded" })
      )
      expect(results).toEqual(["clean", "clean", "clean"])
      expect(stderr.filter((entry) => entry === "INIT")).toHaveLength(1) // one instance for all fibers
    }))

  it.effect("accepts a precompiled WebAssembly.Module as well as raw bytes", () =>
    Effect.gen(function*() {
      const module = yield* Effect.promise(() =>
        WebAssembly.compile(
          Uint8Array.from(fakeFlowsJjWasm({ response: "{\"ok\":{\"status\":\"ok\"}}" }))
        )
      )
      expect(yield* run({ wasm: module, fs: slice }, (jj) => jj.status())).toBe("ok")
    }))

  it.effect("decodes err responses onto the frozen JjError codes", () =>
    Effect.gen(function*() {
      const conflicted = fakeFlowsJjWasm({
        response: "{\"err\":{\"code\":\"conflict\",\"message\":\"would conflict\",\"command\":\"jj snapshot\"}}"
      })
      const error = yield* flip({ wasm: conflicted, fs: slice }, (jj) => jj.snapshot("x"))
      expect(error).toMatchObject({
        code: "conflict",
        message: "jj snapshot: would conflict",
        command: "jj snapshot"
      })

      const missing = fakeFlowsJjWasm({
        response: "{\"err\":{\"code\":\"invalid_ref\",\"message\":\"no such revision\"}}"
      })
      const invalid = yield* flip({ wasm: missing, fs: slice }, (jj) => jj.restore("zzz"))
      expect(invalid.code).toBe("invalid_ref")
      expect(invalid.message).toBe("jj restore: no such revision")
      expect(invalid.command).toBeUndefined()

      const absent = fakeFlowsJjWasm({ response: "{\"err\":{\"code\":\"not_installed\",\"message\":\"n\"}}" })
      expect((yield* flip({ wasm: absent, fs: slice }, (jj) => jj.status())).code).toBe("not_installed")
    }))

  it.effect("degrades err responses outside the frozen vocabulary to unknown", () =>
    Effect.gen(function*() {
      const weird = fakeFlowsJjWasm({ response: "{\"err\":{\"code\":\"weird\",\"message\":\"m\"}}" })
      const error = yield* flip({ wasm: weird, fs: slice }, (jj) => jj.status())
      expect(error.code).toBe("unknown")
      expect(error.message).toBe("jj status: m")

      const bare = fakeFlowsJjWasm({ response: "{\"err\":\"boom\"}" })
      const bareError = yield* flip({ wasm: bare, fs: slice }, (jj) => jj.status())
      expect(bareError.code).toBe("unknown")
      expect(bareError.message).toBe("jj status: \"boom\"")

      const silent = fakeFlowsJjWasm({ response: "{\"err\":{\"code\":\"conflict\"}}" })
      const silentError = yield* flip({ wasm: silent, fs: slice }, (jj) => jj.status())
      expect(silentError.code).toBe("conflict")
      expect(silentError.message).toBe("jj status: {\"code\":\"conflict\"}")
    }))

  it.effect("treats responses outside the {ok}|{err} envelope as unknown failures", () =>
    Effect.gen(function*() {
      for (const response of ["not json", "42", "null", "{\"ok\":\"nope\"}", "{\"neither\":1}"]) {
        const error = yield* flip({ wasm: fakeFlowsJjWasm({ response }), fs: slice }, (jj) => jj.status())
        expect(error.code, response).toBe("unknown")
        expect(error.message, response).toContain("malformed ABI response")
      }
    }))

  it.effect("fails an operation whose ok payload is missing its field", () =>
    Effect.gen(function*() {
      const empty = fakeFlowsJjWasm({ response: "{\"ok\":{}}" })
      const cases: Array<readonly [(jj: Jj) => Effect.Effect<unknown, JjFailure>, string]> = [
        [(jj) => jj.snapshot(), "changeId"],
        [(jj) => jj.diff("a", "b"), "diff"],
        [(jj) => jj.status(), "status"]
      ]
      for (const [operation, field] of cases) {
        const error = yield* flip({ wasm: empty, fs: slice }, operation)
        expect(error.code).toBe("unknown")
        expect(error.message).toContain(`missing the "${field}" field`)
      }
    }))

  it.effect("reports instantiation failure per operation and retries on the next", () =>
    Effect.gen(function*() {
      const options: BrowserJj.BrowserJjOptions = { wasm: new Uint8Array([1, 2, 3]), fs: slice }
      const jj = yield* (Effect.provide(Jj, BrowserJj.layer(options)))
      const first = yield* (Effect.flip(jj.status()))
      expect(first.code).toBe("unknown")
      expect(first.message).toContain("failed to instantiate flows_jj.wasm")
      const second = yield* (Effect.flip(jj.snapshot()))
      expect(second.message).toContain("failed to instantiate flows_jj.wasm")
    }))

  it.effect("names every missing export of a module that does not speak the ABI", () =>
    Effect.gen(function*() {
      const error = yield* flip({ wasm: emptyWasmModule(), fs: slice }, (jj) => jj.status())
      expect(error.code).toBe("unknown")
      expect(error.message).toContain("missing: memory, _initialize, flows_jj_alloc, flows_jj_free, flows_jj_call")
    }))

  it.effect("stringifies non-Error instantiation failures", () =>
    Effect.gen(function*() {
      const options: BrowserJj.BrowserJjOptions = {
        fs: slice,
        get wasm(): WebAssembly.Module {
          throw "boom" // eslint-disable-line no-throw-literal
        }
      }
      const error = yield* flip(options, (jj) => jj.status())
      expect(error.message).toBe("jj: failed to instantiate flows_jj.wasm: boom")
    }))

  it.effect("frees the request and response buffers on the success path", () =>
    Effect.gen(function*() {
      const stderr: Array<string> = []
      const options: BrowserJj.BrowserJjOptions = {
        wasm: fakeFlowsJjWasm({ response: "{\"ok\":{\"status\":\"clean\"}}", logAllocs: true }),
        fs: slice,
        onStderr: (text) => stderr.push(text)
      }
      expect(yield* run(options, (jj) => jj.status())).toBe("clean")
      expect(stderr.filter((entry) => entry === "ALOC")).toHaveLength(1) // the request buffer
      expect(stderr.filter((entry) => entry === "FREE")).toHaveLength(2) // response, then request
    }))

  it.effect("frees the request buffer even when flows_jj_call traps", () =>
    Effect.gen(function*() {
      const stderr: Array<string> = []
      const options: BrowserJj.BrowserJjOptions = {
        wasm: fakeFlowsJjWasm({ trap: true, logAllocs: true }),
        fs: slice,
        onStderr: (text) => stderr.push(text)
      }
      const error = yield* flip(options, (jj) => jj.status())
      expect(error.code).toBe("unknown")
      // The instance stays cached and reused after a trap, so the error path
      // must free what it allocated: exactly one ALOC, exactly one FREE.
      expect(stderr.filter((entry) => entry === "ALOC")).toHaveLength(1)
      expect(stderr.filter((entry) => entry === "FREE")).toHaveLength(1)
    }))

  it.effect("surfaces a proc_exit trap as a failed operation naming the command", () =>
    Effect.gen(function*() {
      const error = yield* flip({ wasm: fakeFlowsJjWasm({ trap: true }), fs: slice }, (jj) => jj.status())
      expect(error.code).toBe("unknown")
      expect(error.message).toBe("jj status: wasm module called proc_exit(7)")
      expect(error.command).toBe("jj status")
    }))

  it.effect("survives a corrupt packed answer pointing outside wasm memory", () =>
    Effect.gen(function*() {
      // ptr far past the module's single memory page: copying the response out
      // throws a RangeError, which must classify as a failed operation.
      const options: BrowserJj.BrowserJjOptions = {
        wasm: fakeFlowsJjWasm({ packedResult: { ptr: 0x7FFF_0000, len: 4096 } }),
        fs: slice
      }
      const jj = yield* (Effect.provide(Jj, BrowserJj.layer(options)))
      const first = yield* (Effect.map(Effect.flip(jj.status()), jjError))
      expect(first.code).toBe("unknown")
      expect(first.command).toBe("jj status")
      // The throw released the semaphore permit: the same instance still answers
      // the next operation instead of deadlocking.
      const second = yield* (Effect.map(Effect.flip(jj.diff("a", "b")), jjError))
      expect(second.code).toBe("unknown")
      expect(second.command).toBe("jj diff")
    }))

  it.effect("survives a corrupt packed answer whose length overruns wasm memory", () =>
    Effect.gen(function*() {
      const overrun = fakeFlowsJjWasm({ packedResult: { ptr: 0, len: 0x7FFF_FFFF } })
      const error = yield* flip({ wasm: overrun, fs: slice }, (jj) => jj.snapshot())
      expect(error.code).toBe("unknown")
      expect(error.message).toContain("jj snapshot: ")
      expect(error.command).toBe("jj snapshot")
    }))
})
