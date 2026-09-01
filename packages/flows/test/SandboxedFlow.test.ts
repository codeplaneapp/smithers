/**
 * `SandboxedFlow` against `DirectorySandbox`: a real bundle, a real guest
 * process, real files, and every failure the host can name.
 *
 * Nothing under test is doubled. The provider is the scratch-directory one
 * over the Node filesystem and spawner, the guest is a real `node` (or `bun`)
 * process running the bundle, and the faults below are injected one layer
 * OUTSIDE the module: a wrapping provider that refuses one operation, a
 * runtime command that exits the way a broken image would, an entry the
 * bundler cannot find, and a host-side declaration that drifted from the one
 * the guest ran.
 */
import { NodeChildProcessSpawner, NodeCrypto, NodeFileSystem } from "@effect/platform-node"
import { afterAll, describe, expect, it } from "@effect/vitest"
import * as Node from "@smthrs/plan/Node"
import { DirectorySandbox, RemoteChildProcessSpawner, type Sandbox } from "@smthrs/sandbox"
import * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Schema from "effect/Schema"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Action, Engine, Flow, Interpreter } from "../src/index.ts"
import * as Guest from "../src/internal/SandboxedFlowGuest.ts"
import * as SandboxedFlow from "../src/SandboxedFlow.ts"
import * as childEntry from "./fixtures/sandboxed-child.ts"
import * as pureEntry from "./fixtures/sandboxed-pure.ts"

const { ProviderError } = RemoteChildProcessSpawner
const { Failing, Filler, Inspector, Sleeper, Sum, Writer } = childEntry

const root = mkdtempSync(join(tmpdir(), "flows-sandboxed-flow-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const entry = new URL("./fixtures/sandboxed-child.ts", import.meta.url)
const pure = new URL("./fixtures/sandboxed-pure.ts", import.meta.url)

const platform = Layer.provideMerge(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)

const provider = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner
  return DirectorySandbox.make({ fs, spawner, root })
}).pipe(Effect.provide(platform))

/** Which session operations a wrapping provider refuses. */
interface Faults {
  readonly writeFile?: (path: string) => boolean
  readonly readFile?: (path: string) => boolean
  readonly spawn?: boolean
  readonly readDirectory?: boolean
}

/**
 * A real provider with one operation refused. The session underneath is the
 * scratch directory's own; only the named call answers with a failure, the
 * way a transport that lost its machine mid-run would.
 */
const faulty = (base: Sandbox.Provider, faults: Faults): Sandbox.Provider => ({
  acquire: (key) =>
    Effect.map(base.acquire(key), (session): Sandbox.Session => ({
      ...session,
      writeFile: (path, content) =>
        faults.writeFile?.(path) === true
          ? Effect.fail(new ProviderError({ code: "unknown", message: `write refused for ${path}` }))
          : session.writeFile(path, content),
      readFile: (path) =>
        faults.readFile?.(path) === true
          ? Effect.fail(new ProviderError({ code: "unknown", message: `read refused for ${path}` }))
          : session.readFile(path),
      spawn: (command, options) =>
        faults.spawn === true
          ? Effect.fail(new ProviderError({ code: "spawn_error", message: "spawn refused" }))
          : session.spawn(command, options),
      files: faults.readDirectory === true
        ? {
          ...session.files,
          readDirectory: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "readDirectory",
                description: "listing refused"
              })
            )
        }
        : session.files
    }))
})

/** A provider that remembers every session key it was asked for. */
const recording = (base: Sandbox.Provider, keys: Array<string>): Sandbox.Provider => ({
  acquire: (key) => {
    keys.push(key)
    return base.acquire(key)
  }
})

const failureOf = <A>(
  effect: Effect.Effect<A, SandboxedFlow.SandboxedFlowError>
): Effect.Effect<SandboxedFlow.SandboxedFlowError, A> => Effect.flip(effect)

const bunInstalled = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0

describe("SandboxedFlow.execute on a scratch machine", () => {
  it.live("runs the child flow's own code in the guest and validates its result", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const result = yield* SandboxedFlow.execute(Sum, { n: 31 }, {
        provider: directory,
        session: "sum",
        entry
      })
      expect(result).toEqual({ output: 42, diff: [] })
      // A normal completion releases the session, which removes the workspace.
      expect(readdirSync(root)).toEqual([])
    }), 60_000)

  it.live("takes a path entry and returns the files the guest wrote as data", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const result = yield* SandboxedFlow.execute(Writer, { count: 3, bytes: 16, directory: "out" }, {
        provider: directory,
        session: "writer",
        entry: realpathSync(new URL(entry)),
        collectDiff: true
      })
      expect(result.output).toBe(3)
      expect(result.diff.map((file) => file.path)).toEqual(["out/file-0.bin", "out/file-1.bin", "out/file-2.bin"])
      expect(result.diff[1]!.bytes).toEqual(new Uint8Array(16).fill(1))
      // The protocol's own files never count as the guest's changes.
      expect(result.diff.some((file) => file.path.startsWith(".smithers-sandbox"))).toBe(false)
    }), 60_000)

  it.live("runs an entry that exports no layer", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const result = yield* SandboxedFlow.execute(pureEntry.Constant, { value: "as it was" }, {
        provider: directory,
        session: "pure",
        entry: pure
      })
      expect(result.output).toBe("as it was")
    }), 60_000)

  it.live("reattaches the machine a previous holder of the session key seeded", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      // The outer holder stands in for a crashed earlier execution: it
      // acquired the key, wrote into the workspace, and never released it.
      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const earlier = yield* directory.acquire("seeded")
          yield* earlier.writeFile(`${earlier.workdir}/seed.txt`, new TextEncoder().encode("from the host"))
          // Read before the execution: its completion releases the key, which
          // removes the workspace under this holder, as the contract says.
          const workdir = realpathSync(earlier.workdir)
          const result = yield* SandboxedFlow.execute(Inspector, { marker: "left by the guest" }, {
            provider: directory,
            session: "seeded",
            entry,
            collectDiff: true,
            limits: { files: 10 },
            timeout: Duration.seconds(30)
          })
          expect(result.output.cwd).toBe(workdir)
          return result
        })
      )
      expect(result.output.seed).toBe("from the host")
      expect(result.output.runtime).toMatch(/^node v/)
      // The seed kept its size, so only the guest's own file is a change.
      expect(result.diff).toEqual([{ path: "marker.txt", bytes: new TextEncoder().encode("left by the guest") }])
    }), 60_000)

  it.live("lists a directory the guest created without reading it as a file", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const result = yield* SandboxedFlow.execute(Writer, { count: 1, bytes: 1, directory: "nested/deep" }, {
        provider: directory,
        session: "nested",
        entry,
        collectDiff: true
      })
      expect(result.diff.map((file) => file.path)).toEqual(["nested/deep/file-0.bin"])
    }), 60_000)
})

describe.skipIf(!bunInstalled)("SandboxedFlow.execute under bun", () => {
  it.live("starts the bundle with the runtime it was told to", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const result = yield* SandboxedFlow.execute(Inspector, { marker: "bun" }, {
        provider: directory,
        session: "bun",
        entry,
        runtime: "bun"
      })
      expect(result.output.runtime).toBe("bun")
    }), 60_000)
})

describe("SandboxedFlow.execute failures", () => {
  const run = <
    Tag extends string,
    Payload extends Flow.AnyStructSchema,
    Success extends Schema.Top,
    Error extends Schema.Top,
    Requires
  >(
    flow: Flow.Flow<Tag, Payload, Success, Error, Requires>,
    payload: Payload["Type"],
    options: Partial<SandboxedFlow.ExecuteOptions>
  ) =>
    Effect.gen(function*() {
      const directory = yield* provider
      return yield* failureOf(
        SandboxedFlow.execute(flow, payload, {
          provider: directory,
          session: `failure-${Date.now()}-${Math.random()}`,
          entry,
          ...options
        })
      )
    })

  it.live("refuses an entry the bundler cannot find", () =>
    Effect.gen(function*() {
      const failure = yield* run(Sum, { n: 1 }, { entry: join(root, "missing-entry.ts") })
      expect(failure.code).toBe("bundle_failed")
      expect(failure.message).toContain("could not be bundled")
      expect(failure.message).toContain("missing-entry.ts")
    }), 60_000)

  it.live("refuses an entry that is not a file", () =>
    Effect.gen(function*() {
      const failure = yield* run(Sum, { n: 1 }, { entry: new URL("https://example.invalid/child.ts") })
      expect(failure.code).toBe("bundle_failed")
      expect(failure.message).toContain("https://example.invalid/child.ts")
    }), 60_000)

  it.live("reports a provider that cannot supply the machine", () =>
    Effect.gen(function*() {
      const failure = yield* run(Sum, { n: 1 }, {
        provider: {
          acquire: () => Effect.fail(new ProviderError({ code: "unavailable", message: "no machines left" }))
        }
      })
      expect(failure.code).toBe("session_failed")
      expect(failure.message).toContain("no machines left")
    }), 60_000)

  it.live("names the runtime the image does not contain", () =>
    Effect.gen(function*() {
      const failure = yield* run(Sum, { n: 1 }, { runtime: "definitely-not-a-runtime-xyz" })
      expect(failure.code).toBe("guest_failed")
      expect(failure.message).toContain("no runnable `definitely-not-a-runtime-xyz`")
      expect(failure.message).toContain("installs none")
    }), 60_000)

  it.live("reports a guest that exits non-zero without fabricating a result", () =>
    Effect.gen(function*() {
      const failure = yield* run(Sum, { n: 1 }, { runtime: "false" })
      expect(failure.code).toBe("guest_failed")
      expect(failure.message).toContain("exited 1")
      expect(failure.message).toContain("stderr: (empty)")
    }), 60_000)

  it.live("reports a guest that exits 0 without writing a result, quoting its stderr", () =>
    Effect.gen(function*() {
      const failure = yield* run(Sum, { n: 1 }, { runtime: "sh -c 'echo nothing to report >&2' sh" })
      expect(failure.code).toBe("result_unreadable")
      expect(failure.message).toContain("without writing a result")
      expect(failure.message).toContain("stderr: nothing to report")
    }), 60_000)

  it.live("reports a result that is not the protocol's JSON, quoting the guest's stdout", () =>
    Effect.gen(function*() {
      const failure = yield* run(Sum, { n: 1 }, {
        runtime: `sh -c 'echo wrote garbage; printf garbage > "$SMITHERS_SANDBOX_RESULT_PATH"' sh`
      })
      expect(failure.code).toBe("result_unreadable")
      expect(failure.message).toContain("not the protocol's JSON")
      expect(failure.message).toContain("stdout: wrote garbage")
    }), 60_000)

  it.live("surfaces a failed child flow with its error and the guest's output", () =>
    Effect.gen(function*() {
      const failure = yield* run(Failing, { reason: "the guest said no", chatter: 5000 }, {})
      expect(failure.code).toBe("flow_failed")
      expect(failure.message).toContain("flows/SandboxedFlow/fixtures/Failing failed in the guest")
      // The typed error arrives as its tag and fields, not as a stack trace.
      expect(failure.message).toContain("flows/SandboxedFlow/fixtures/Refused {\"reason\":\"the guest said no\"}")
      expect(failure.message).not.toContain("    at ")
      // Long output is quoted from its tail, marked as cut.
      expect(failure.message).toContain("stdout: …ccc")
      expect(failure.message).not.toContain("c".repeat(5000))
    }), 60_000)

  it.live("surfaces an entry that exports no flow of the requested tag", () =>
    Effect.gen(function*() {
      const Unknown = Flow.make("flows/SandboxedFlow/fixtures/Unknown", {
        payload: { n: Schema.Number },
        success: Schema.Number,
        body: (payload) => Node.succeed(payload.n)
      })
      const failure = yield* run(Unknown, { n: 1 }, {})
      expect(failure.code).toBe("flow_failed")
      expect(failure.message).toContain("exports no flow tagged \"flows/SandboxedFlow/fixtures/Unknown\"")
      expect(failure.message).toContain("stdout: (empty); stderr: (empty)")
    }), 60_000)

  it.live("refuses an output the host's success schema does not decode", () =>
    Effect.gen(function*() {
      // The host's declaration drifted from the one the guest bundles: same
      // tag, a different success schema.
      const Drifted = Flow.make("flows/SandboxedFlow/fixtures/Sum", {
        payload: { n: Schema.Number },
        success: Schema.String,
        body: () => Node.succeed("")
      })
      const failure = yield* run(Drifted, { n: 1 }, {})
      expect(failure.code).toBe("result_invalid")
      expect(failure.message).toContain("does not decode through the success schema")
    }), 60_000)

  it.live("refuses a result larger than the limit", () =>
    Effect.gen(function*() {
      const failure = yield* run(Filler, { bytes: 20_000 }, { limits: { resultBytes: 1024 } })
      expect(failure.code).toBe("result_overflow")
      expect(failure.message).toContain("the limit is 1024")
    }), 60_000)

  it.live("refuses a diff with more files than the limit", () =>
    Effect.gen(function*() {
      const failure = yield* run(Writer, { count: 5, bytes: 1, directory: "many" }, {
        collectDiff: true,
        limits: { files: 2 }
      })
      expect(failure.code).toBe("diff_overflow")
      expect(failure.message).toContain("changed 5 files; the limit is 2")
    }), 60_000)

  it.live("refuses a diff with more bytes than the limit", () =>
    Effect.gen(function*() {
      const failure = yield* run(Writer, { count: 2, bytes: 4096, directory: "large" }, {
        collectDiff: true,
        limits: { diffBytes: 4096 }
      })
      expect(failure.code).toBe("diff_overflow")
      expect(failure.message).toContain("hold 8192 bytes; the limit is 4096")
    }), 60_000)

  it.live(
    "convicts a guest that outlives the wall-clock deadline and releases the machine",
    () =>
      Effect.gen(function*() {
        const directory = yield* provider
        const started = Date.now()
        const failure = yield* failureOf(
          SandboxedFlow.execute(Sleeper, { ms: 60_000 }, {
            provider: directory,
            session: "sleeper",
            entry,
            timeout: Duration.millis(1500)
          })
        )
        expect(failure.code).toBe("deadline_exceeded")
        expect(failure.message).toContain("1500 milliseconds")
        expect(Date.now() - started).toBeLessThan(30_000)
        expect(readdirSync(root)).toEqual([])
      }),
    60_000
  )

  it.live("reports a workspace that refuses the bundle", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const failure = yield* failureOf(
        SandboxedFlow.execute(Sum, { n: 1 }, {
          provider: faulty(directory, { writeFile: (path) => path.endsWith("bundle.mjs") }),
          session: "refuses-bundle",
          entry
        })
      )
      expect(failure.code).toBe("session_failed")
      expect(failure.message).toContain("the bundle could not be written")
    }), 60_000)

  it.live("reports a workspace that refuses the request", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const failure = yield* failureOf(
        SandboxedFlow.execute(Sum, { n: 1 }, {
          provider: faulty(directory, { writeFile: (path) => path.endsWith("request.json") }),
          session: "refuses-request",
          entry
        })
      )
      expect(failure.code).toBe("session_failed")
      expect(failure.message).toContain("the request could not be written")
    }), 60_000)

  it.live("reports a session that cannot start the runtime", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const failure = yield* failureOf(
        SandboxedFlow.execute(Sum, { n: 1 }, {
          provider: faulty(directory, { spawn: true }),
          session: "refuses-spawn",
          entry
        })
      )
      expect(failure.code).toBe("session_failed")
      expect(failure.message).toContain("could not be run in the session")
      expect(failure.message).toContain("spawn refused")
    }), 60_000)

  it.live("reports a result the session cannot read back", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const failure = yield* failureOf(
        SandboxedFlow.execute(Sum, { n: 1 }, {
          provider: faulty(directory, { readFile: (path) => path.endsWith("result.json") }),
          session: "refuses-result",
          entry
        })
      )
      expect(failure.code).toBe("session_failed")
      expect(failure.message).toContain("the result could not be read back")
    }), 60_000)

  it.live("reports a changed file the session cannot read back", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const failure = yield* failureOf(
        SandboxedFlow.execute(Writer, { count: 1, bytes: 1, directory: "unreadable" }, {
          provider: faulty(directory, { readFile: (path) => path.endsWith("file-0.bin") }),
          session: "refuses-diff",
          entry,
          collectDiff: true
        })
      )
      expect(failure.code).toBe("session_failed")
      expect(failure.message).toContain("the changed file unreadable/file-0.bin could not be read back")
    }), 60_000)

  it.live("reports a workspace that cannot be listed", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const failure = yield* failureOf(
        SandboxedFlow.execute(Sum, { n: 1 }, {
          provider: faulty(directory, { readDirectory: true }),
          session: "refuses-listing",
          entry,
          collectDiff: true
        })
      )
      expect(failure.code).toBe("session_failed")
      expect(failure.message).toContain("the workspace could not be listed")
      expect(failure.message).toContain("listing refused")
    }), 60_000)
})

describe("SandboxedFlow.action on an engine", () => {
  const RunSum = SandboxedFlow.action(Sum)
  const Parent = Flow.make("flows/SandboxedFlow/test/Parent", {
    payload: { n: Schema.Number },
    success: SandboxedFlow.resultSchema(Schema.Number),
    error: SandboxedFlow.SandboxedFlowError,
    body: (payload) => RunSum.call(payload)
  })

  const engine = <R>(implementation: Layer.Layer<Action.Requirement<string>, never, R>) =>
    Layer.mergeAll(implementation, Interpreter.layer(Parent)).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(Engine.FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer)
    )

  it("declares the action over the child's schemas under a derived tag", () => {
    expect(RunSum.name).toBe("flows/SandboxedFlow/fixtures/Sum/sandboxed")
    expect(SandboxedFlow.action(Sum, { name: "custom/RunSum" }).name).toBe("custom/RunSum")
    expect(RunSum.payloadSchema).toBe(Sum.payloadSchema)
    expect(RunSum.errorSchema).toBe(SandboxedFlow.SandboxedFlowError)
  })

  it.live("runs the child as one action of the parent's plan", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const result = yield* Parent.execute({ n: 31 }, { executionId: "parent-static" }).pipe(
        Effect.provide(
          engine(SandboxedFlow.toLayer(RunSum, Sum, { provider: directory, session: "action-static", entry }))
        )
      )
      expect(result).toEqual({ output: 42, diff: [] })
    }), 60_000)

  it.live("derives the placement from the call and the parent execution", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const keys: Array<string> = []
      const result = yield* Parent.execute({ n: 5 }, { executionId: "parent-derived" }).pipe(
        Effect.provide(
          engine(
            SandboxedFlow.toLayer(RunSum, Sum, ({ executionId, payload }) => ({
              provider: recording(directory, keys),
              session: `child:${executionId}:${payload.n}`,
              entry
            }))
          )
        )
      )
      expect(result.output).toBe(16)
      expect(keys).toEqual(["child:parent-derived:5"])
    }), 60_000)

  it.live("fails the parent with the typed error the sandbox reported", () =>
    Effect.gen(function*() {
      const directory = yield* provider
      const failure = yield* Effect.flip(
        Parent.execute({ n: 1 }, { executionId: "parent-failing" }).pipe(
          Effect.provide(
            engine(SandboxedFlow.toLayer(RunSum, Sum, {
              provider: directory,
              session: "action-failing",
              entry: join(root, "no-such-entry.ts")
            }))
          )
        )
      )
      expect(failure).toBeInstanceOf(SandboxedFlow.SandboxedFlowError)
      expect((failure as SandboxedFlow.SandboxedFlowError).code).toBe("bundle_failed")
    }), 60_000)
})

describe("the result schema", () => {
  it("encodes a result with its bytes as base64 for the journal", () => {
    const encoded = Schema.encodeSync(Schema.toCodecJson(SandboxedFlow.resultSchema(Schema.Number)))({
      output: 42,
      diff: [{ path: "a.bin", bytes: new Uint8Array([1, 2, 3]) }]
    })
    expect(encoded).toEqual({ output: 42, diff: [{ path: "a.bin", bytes: "AQID" }] })
  })

  it("carries the 0.x bundle limits as its defaults", () => {
    expect(SandboxedFlow.defaultLimits).toEqual({
      resultBytes: 5 * 1024 * 1024,
      diffBytes: 100 * 1024 * 1024,
      files: 1000
    })
  })
})

describe("the guest crypto", () => {
  it.live("digests exactly as the host's NodeCrypto does", () =>
    Effect.gen(function*() {
      const material = new TextEncoder().encode("the same key material on both sides of the machine boundary")
      const host = yield* Crypto.Crypto
      const inGuest = yield* Guest.guestCrypto.digest("SHA-256", material)
      const onHost = yield* host.digest("SHA-256", material)
      expect(inGuest).toEqual(onHost)
      expect(yield* Guest.guestCrypto.randomBytes(16)).toHaveLength(16)
    }).pipe(Effect.provide(NodeCrypto.layer)))
})

describe("the guest runner in process", () => {
  const scratch = mkdtempSync(join(tmpdir(), "flows-sandboxed-guest-"))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  const request = (name: string, body: typeof Guest.Request.Type): Guest.Environment => {
    const requestPath = join(scratch, `${name}.request.json`)
    writeFileSync(requestPath, JSON.stringify(body))
    return {
      SMITHERS_SANDBOX_REQUEST_PATH: requestPath,
      SMITHERS_SANDBOX_RESULT_PATH: join(scratch, `${name}.result.json`)
    }
  }

  const resultOf = (environment: Guest.Environment): typeof Guest.Result.Type =>
    Schema.decodeUnknownSync(Guest.Result)(
      JSON.parse(readFileSync(environment.SMITHERS_SANDBOX_RESULT_PATH!, "utf8"))
    )

  it("refuses to start without the request path", async () => {
    await expect(Guest.run(childEntry, {})).rejects.toThrow("SMITHERS_SANDBOX_REQUEST_PATH is not set")
  })

  it("refuses to start without the result path", async () => {
    await expect(Guest.run(childEntry, { SMITHERS_SANDBOX_REQUEST_PATH: join(scratch, "unused.json") }))
      .rejects.toThrow("SMITHERS_SANDBOX_RESULT_PATH is not set")
  })

  it("writes the encoded success of the flow the request names", async () => {
    const environment = request("sum", { flow: Sum._tag, executionId: "in-process", payload: { n: 1 } })
    await Guest.run(childEntry, environment)
    expect(resultOf(environment)).toEqual({ status: "finished", output: 12 })
  })

  it("writes the failure of a flow that failed", async () => {
    const environment = request("failing", {
      flow: Failing._tag,
      executionId: "in-process",
      payload: { reason: "refused in process", chatter: 0 }
    })
    await Guest.run(childEntry, environment)
    const result = resultOf(environment)
    expect(result.status).toBe("failed")
    expect(result.status === "failed" && result.error).toContain("refused in process")
  })

  it("writes a failure for a payload the flow's schema refuses", async () => {
    const environment = request("bad-payload", { flow: Sum._tag, executionId: "in-process", payload: { n: "one" } })
    await Guest.run(childEntry, environment)
    expect(resultOf(environment).status).toBe("failed")
  })

  it("writes a failure for a tag the entry does not export", async () => {
    const environment = request("unknown", { flow: "nowhere/Flow", executionId: "in-process", payload: {} })
    await Guest.run(childEntry, environment)
    const result = resultOf(environment)
    expect(result.status === "failed" && result.error).toContain("exports no flow tagged \"nowhere/Flow\"")
  })

  it("runs an entry without a layer", async () => {
    const environment = request("pure", {
      flow: pureEntry.Constant._tag,
      executionId: "in-process",
      payload: { value: "still here" }
    })
    await Guest.run(pureEntry, environment)
    expect(resultOf(environment)).toEqual({ status: "finished", output: "still here" })
  })

  it("drives a child boundary the entry registered beside its flow", async () => {
    const environment = request("nested", {
      flow: childEntry.Nested._tag,
      executionId: "in-process",
      payload: { n: 4 }
    })
    await Guest.run(childEntry, environment)
    expect(resultOf(environment)).toEqual({ status: "finished", output: 15 })
  })

  it("describes a defect by its name and message", async () => {
    const environment = request("dying", {
      flow: childEntry.Dying._tag,
      executionId: "in-process",
      payload: { message: "boom", shape: "error" }
    })
    await Guest.run(childEntry, environment)
    const result = resultOf(environment)
    expect(result.status === "failed" && result.error).toBe("defect Error: boom")
  })

  it("describes a defect it cannot serialize without dying on it", async () => {
    const environment = request("dying-cyclic", {
      flow: childEntry.Dying._tag,
      executionId: "in-process",
      payload: { message: "", shape: "cyclic" }
    })
    await Guest.run(childEntry, environment)
    const result = resultOf(environment)
    expect(result.status === "failed" && result.error).toBe("defect failure")
  })

  it("describes a bare failure value as itself", async () => {
    const environment = request("plain", {
      flow: childEntry.Plain._tag,
      executionId: "in-process",
      payload: { text: "plainly refused" }
    })
    await Guest.run(childEntry, environment)
    const result = resultOf(environment)
    expect(result.status === "failed" && result.error).toBe("plainly refused")
  })

  it("describes the engine's refusal of a typed error it cannot encode", async () => {
    const environment = request("cyclic", { flow: childEntry.Cyclic._tag, executionId: "in-process", payload: {} })
    await Guest.run(childEntry, environment)
    const result = resultOf(environment)
    // The engine encodes a typed error for its journal before the runner sees
    // it, so a cyclic one arrives as the engine's own defect.
    expect(result.status === "failed" && result.error).toMatch(/^defect SchemaError: Expected JSON value \{/)
  })

  it("quotes a failure's fields within a bound", async () => {
    const environment = request("dying-large", {
      flow: childEntry.Dying._tag,
      executionId: "in-process",
      payload: { message: "d".repeat(5000), shape: "large" }
    })
    await Guest.run(childEntry, environment)
    const result = resultOf(environment)
    const error = result.status === "failed" ? result.error : ""
    expect(error.startsWith("defect failure {\"detail\":\"ddd")).toBe(true)
    expect(error.endsWith("…")).toBe(true)
    expect(error.length).toBeLessThan(1100)
  })

  it("describes an interruption", async () => {
    const environment = request("interrupting", {
      flow: childEntry.Interrupting._tag,
      executionId: "in-process",
      payload: {}
    })
    await Guest.run(childEntry, environment)
    const result = resultOf(environment)
    expect(result.status === "failed" && result.error).toContain("interrupted")
  })
})
