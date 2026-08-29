import { NodeServices } from "@effect/platform-node"
import { Control as ControlService, ControlError, ControlRuntime, type ControlSchema } from "@smthrs/control"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { TestConsole } from "effect/testing"
import { Command } from "effect/unstable/cli"
import { HttpServer } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import { cli } from "../src/Command.ts"
import * as ExecutorOwnership from "../src/ExecutorOwnership.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Output from "../src/Output.ts"
import { packageVersion } from "../src/Version.ts"

interface Invocation {
  readonly value: unknown
  readonly exitCode: number
}

const runCommand = Command.runWith(cli, { version: packageVersion })

const invoke = Effect.fnUntraced(function*(args: ReadonlyArray<string>) {
  const before = (yield* TestConsole.logLines).length
  const exit = yield* Effect.exit(runCommand(args))
  if (Exit.isFailure(exit)) {
    return yield* Effect.fail(Cause.squash(exit.cause))
  }

  const lines = yield* TestConsole.logLines
  const text = lines.slice(before).map(String).join("\n")
  if (text.length === 0) {
    return yield* Effect.fail(new Error(`command produced no output: ${args.join(" ")}`))
  }
  const value = yield* Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => new Error(`command produced invalid JSON: ${String(cause)}`)
  })
  return { value, exitCode: Output.exitCode(value) } satisfies Invocation
})

const scenario = (shared: ReadonlyArray<string> = []) =>
  Effect.gen(function*() {
    const plan = yield* invoke(["--json", ...shared, "plan", "system/test"])

    const card = plan.value as {
      readonly approval: unknown
    }
    const approval = yield* Effect.try({
      try: () => {
        if (
          card.approval === null ||
          typeof card.approval !== "object" ||
          !("target" in card.approval) ||
          !("idempotencyKey" in card.approval)
        ) {
          throw new Error("plan did not emit the complete approval payload")
        }
        return JSON.stringify(card.approval)
      },
      catch: (cause) => cause instanceof Error ? cause : new Error(String(cause))
    })
    const parked = yield* invoke(["--json", ...shared, "run", approval])
    const approve = yield* invoke(["--json", ...shared, "approve", approval, "--scope", "run"])
    const run = yield* invoke(["--json", ...shared, "run", approval])
    const runId = (run.value as { readonly runId?: unknown }).runId
    if (typeof runId !== "string") return yield* Effect.fail(new Error("run did not emit its identifier"))
    const status = yield* invoke(["--json", ...shared, "status", runId])
    const missingStatus = yield* invoke(["--json", ...shared, "status", `missing-${runId}`])
    const logs = yield* invoke(["--json", ...shared, "logs", runId]).pipe(Effect.timeout("2 seconds"))

    return { plan, parked, approve, run, runId, status, missingStatus, logs }
  })

const scenarioServices = Layer.merge(TestConsole.layer, Output.layer)

const normalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalize)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "createdAt" && key !== "updatedAt" && key !== "stampedAt" && key !== "occurredAt")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)])
    )
  }
  return value
}

const isWaitingForApproval = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  (
    (value as { readonly _tag?: unknown })._tag === "Parked" ||
    (value as { readonly status?: unknown }).status === "waiting-approval"
  )

const addressUrl = (server: HttpServer.HttpServer["Service"]): string => {
  const address = server.address
  if (address._tag !== "TcpAddress") throw new Error("expected a TCP control server")
  return `http://127.0.0.1:${address.port}`
}

const testControl = TestControl.layer({ now: () => 0 })
const websocketEvent = {
  sequence: 1,
  kind: "control.websocket.connected",
  occurredAt: 0,
  payload: null
}
const streamingControl = Layer.effect(
  ControlService.Control,
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    return ControlService.make({
      ...control,
      watch: () => Stream.succeed(websocketEvent)
    })
  })
).pipe(Layer.provide(testControl))
const nonTerminalControl = Layer.effect(
  ControlService.Control,
  Effect.gen(function*() {
    const control = yield* ControlService.Control
    return ControlService.make({
      ...control,
      watch: () => Stream.never
    })
  })
).pipe(Layer.provide(testControl))

describe("Control surface", () => {
  it("parses the remote bearer credential from either CLI spelling", () => {
    expect(NodeControl.makeConfig([
      "--remote",
      "https://control.example.test",
      "--credential=alpha-secret"
    ], {})).toEqual({
      remote: "https://control.example.test",
      credential: "alpha-secret"
    })
  })

  it("prints the package version", async () => {
    const lines = await Effect.runPromise(
      Effect.gen(function*() {
        yield* runCommand(["--version"])
        return yield* TestConsole.logLines
      }).pipe(
        Effect.provide(testControl),
        Effect.provide(scenarioServices),
        Effect.provide(NodeServices.layer)
      )
    )

    expect(lines.map(String).join("\n")).toContain(packageVersion)
  })

  it.each(
    [
      ["plan data", ["plan", "system/test", "--data", "{"]],
      ["run approval", ["run", "{"]],
      ["approve payload", ["approve", "{"]],
      ["deny payload", ["deny", "{"]],
      ["signal payload", ["signal", "run-1", "{"]]
    ] as const
  )("rejects malformed JSON in %s as a usage error", async (_label, args) => {
    const exit = await Effect.runPromise(
      Effect.exit(runCommand(args)).pipe(
        Effect.provide(testControl),
        Effect.provide(scenarioServices),
        Effect.provide(NodeServices.layer)
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(CliError.UsageError)
      expect(CliError.exitCode(error as CliError.UsageError)).toBe(2)
    }
  })

  it("reports a schema-invalid approval payload truthfully", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(runCommand(["run", "{}"])).pipe(
        Effect.provide(testControl),
        Effect.provide(scenarioServices),
        Effect.provide(NodeServices.layer)
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause)
      expect(error).toBeInstanceOf(CliError.UsageError)
      expect((error as CliError.UsageError).message).toBe("approval must match the expected payload schema")
      expect(CliError.exitCode(error as CliError.UsageError)).toBe(2)
    }
  })

  it("mounts the remote parser path on a real ephemeral Node server", async () => {
    const local = await Effect.runPromise(
      invoke(["--json", "plan", "system/test"]).pipe(
        Effect.provide(testControl),
        Effect.provide(scenarioServices),
        Effect.provide(NodeServices.layer)
      )
    )
    const remote = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* HttpServer.HttpServer
        return yield* invoke(["--json", "plan", "system/test"]).pipe(
          Effect.provide(NodeControl.layerControl({ remote: addressUrl(server) })),
          Effect.provide(scenarioServices)
        )
      }).pipe(
        Effect.provide(
          NodeControl.layerServerNoopAuth({ host: "127.0.0.1", port: 0 }).pipe(
            Layer.provide(testControl)
          )
        ),
        Effect.scoped
      )
    )

    expect(normalize(remote)).toEqual(normalize(local))
  })

  it("renders an accepted non-terminal remote run without awaiting server settlement", async () => {
    const accepted = await Effect.runPromise(
      Effect.gen(function*() {
        const shared = ["--remote", "http://control.example.test"]
        const planned = yield* invoke(["--json", ...shared, "plan", "system/test"])
        const card = planned.value as { readonly approval: unknown }
        const approval = JSON.stringify(card.approval)
        yield* invoke(["--json", ...shared, "approve", approval])
        return yield* invoke(["--json", ...shared, "run", approval]).pipe(Effect.timeout("1 second"))
      }).pipe(
        Effect.provide(nonTerminalControl),
        Effect.provide(scenarioServices),
        Effect.provide(NodeServices.layer)
      )
    )

    expect(accepted.value).toMatchObject({ _tag: "Accepted", runId: expect.any(String) })
  })

  it("renders the receipt when the owned executor declines to execute the run", async () => {
    const accepted = await Effect.runPromise(
      Effect.gen(function*() {
        const planned = yield* invoke(["--json", "plan", "system/test"])
        const card = planned.value as { readonly approval: unknown }
        const approval = JSON.stringify(card.approval)
        yield* invoke(["--json", "approve", approval])
        // The noop test executor answers `pending`, so the run never reaches
        // `running` or a terminal status; the owned wait must still settle.
        return yield* invoke(["--json", "run", approval]).pipe(Effect.timeout("5 seconds"))
      }).pipe(
        Effect.provide(ExecutorOwnership.layer(true)),
        Effect.provide(testControl),
        Effect.provide(scenarioServices),
        Effect.provide(NodeServices.layer)
      )
    )

    expect(accepted.value).toMatchObject({ _tag: "Accepted", runId: expect.any(String) })
  })

  it("waits for a fresh park after resuming an owned run", async () => {
    const runId = "run-parked-twice"
    const event = (sequence: number, kind: string): ControlSchema.ControlEvent => ({
      sequence,
      kind,
      runId,
      occurredAt: 0,
      payload: null
    })
    const committed = [event(1, "control.run.waiting-approval"), event(2, "control.run.resume")]
    const freshPark = event(3, "control.run.waiting-approval")
    const watched: Array<ControlSchema.WatchFilter> = []
    // Mirrors ControlLive.watch: a snapshot returns only committed history, a
    // follow replays committed history after the cursor and then stays open.
    const doubleParkControl = Layer.effect(
      ControlService.Control,
      Effect.gen(function*() {
        const control = yield* ControlService.Control
        return ControlService.make({
          ...control,
          resume: (input) => Effect.succeed({ _tag: "Accepted", receiptId: input.idempotencyKey, runId }),
          watch: (filter) => {
            watched.push(filter)
            const visible = (events: ReadonlyArray<ControlSchema.ControlEvent>) =>
              events.filter((entry) => filter.afterSequence === undefined || entry.sequence > filter.afterSequence)
            return filter.follow === false
              ? Stream.fromIterable(visible(committed))
              : Stream.fromIterable(visible([...committed, freshPark])).pipe(Stream.concat(Stream.never))
          }
        })
      })
    ).pipe(Layer.provide(testControl))

    const receipt = await Effect.runPromise(
      invoke(["--json", "run", runId, "--resume"]).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(ExecutorOwnership.layer(true)),
        Effect.provide(doubleParkControl),
        Effect.provide(scenarioServices),
        Effect.provide(NodeServices.layer)
      )
    )

    // The resume mutation is keyed to the park it resumes, and the settlement
    // wait must scope past that park so its replay cannot satisfy it.
    expect(receipt.value).toMatchObject({
      _tag: "Accepted",
      runId,
      receiptId: `cli:resume:${runId}:1`
    })
    expect(watched).toContainEqual({ runId, follow: false })
    expect(watched).toContainEqual({ runId, afterSequence: 1 })
  })

  it("re-drives a second park instead of replaying the first resume receipt", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* ControlService.Control
        const runtime = yield* ControlRuntime.ControlRuntime
        const journal = yield* Journal.Journal

        const planned = yield* invoke(["--json", "plan", "system/test"])
        const card = planned.value as { readonly approval: unknown }
        const approval = JSON.stringify(card.approval)
        yield* invoke(["--json", "approve", approval])
        const run = yield* invoke(["--json", "run", approval])
        const runId = (run.value as { readonly runId?: unknown }).runId
        if (typeof runId !== "string") return yield* Effect.fail(new Error("run did not emit its identifier"))

        // One park is one fenced status write plus its journal record,
        // exactly as the production executor publishes it.
        const park = Effect.gen(function*() {
          const fence = yield* runtime.claimFence(runId)
          yield* runtime.writeStatus(runId, fence, "waiting-approval")
          yield* journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId: JournalEvent.RunId.make(runId),
              sourceId: JournalEvent.SourceId.make("/test/executor"),
              eventType: "control.run.waiting-approval",
              payload: { runId, status: "waiting-approval" }
            })
          )
        })

        yield* park
        const first = yield* invoke(["--json", "run", runId, "--resume"])
        yield* park
        const second = yield* invoke(["--json", "run", runId, "--resume"])

        const resumes = yield* control.watch({ runId, follow: false }).pipe(
          Stream.filter((event) => event.kind === "control.run.resume"),
          Stream.runCollect
        )
        return {
          first: first.value as { readonly _tag?: string; readonly receiptId?: string },
          second: second.value as { readonly _tag?: string; readonly receiptId?: string },
          resumes: resumes.length,
          status: (yield* runtime.getRun(runId)).status
        }
      }).pipe(
        Effect.provide(testControl),
        Effect.provide(scenarioServices),
        Effect.provide(NodeServices.layer)
      )
    )

    // Each park keys its own resume mutation, so the second resume evaluates
    // and emits its own `control.run.resume` instead of replaying the first
    // resume's recorded receipt while the run stays parked.
    expect(result.first).toMatchObject({ _tag: "Accepted" })
    expect(result.second).toMatchObject({ _tag: "Accepted" })
    expect(result.second.receiptId).not.toBe(result.first.receiptId)
    expect(result.resumes).toBe(2)
    expect(result.status).toBe("accepted")
  })

  it("runs plan, approval, launch, and finite logs through an authenticated remote server", async () => {
    const local = await Effect.runPromise(
      scenario().pipe(
        Effect.provide(testControl),
        Effect.provide(scenarioServices),
        Effect.provide(NodeServices.layer)
      )
    )

    const remote = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* HttpServer.HttpServer
        const shared = ["--remote", addressUrl(server), "--credential", "alpha-secret"]
        const result = yield* scenario(shared).pipe(
          Effect.provide(NodeControl.layerControl(NodeControl.makeConfig(shared, {}))),
          Effect.provide(scenarioServices)
        )
        return { hostname: server.address._tag === "TcpAddress" ? server.address.hostname : "", result }
      }).pipe(
        Effect.provide(
          NodeControl.layerServerBearerAuth({
            token: "alpha-secret",
            principal: { id: "alpha", kind: "bearer" },
            now: () => 0
          }, { port: 0 }).pipe(
            Layer.provide(testControl)
          )
        ),
        Effect.scoped
      )
    )

    expect(isWaitingForApproval(local.parked.value)).toBe(true)
    expect(isWaitingForApproval(remote.result.parked.value)).toBe(true)
    expect(local.parked.exitCode).toBe(3)
    expect(remote.result.parked.exitCode).toBe(3)
    expect(local.status.value).toMatchObject({ _tag: "runs", items: [{ runId: local.runId }] })
    expect(local.missingStatus.value).toEqual({ _tag: "runs", items: [] })
    expect(Array.isArray(local.logs.value)).toBe(true)
    expect((local.logs.value as ReadonlyArray<unknown>).length).toBeGreaterThan(0)
    expect(remote.hostname).toBe("127.0.0.1")
    expect(normalize(remote.result)).toEqual(normalize(local))
  })

  it("refuses an unauthenticated request on an explicitly exposed bind", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* HttpServer.HttpServer
        return yield* Effect.gen(function*() {
          const control = yield* ControlService.Control
          return yield* control.plan({ flowId: "system/test", input: {} }).pipe(Effect.flip)
        }).pipe(
          Effect.provide(NodeControl.layerControl({ remote: addressUrl(server) }))
        )
      }).pipe(
        Effect.provide(
          NodeControl.layerServerBearerAuth({
            token: "alpha-secret",
            principal: { id: "alpha", kind: "bearer" }
          }, { host: "0.0.0.0", port: 0, listen: true }).pipe(
            Layer.provide(testControl)
          )
        ),
        Effect.scoped
      )
    )

    expect(error).toBeInstanceOf(ControlError.Unauthorized)
  })

  it("refuses non-loopback binds without --listen and always confines noop auth", () => {
    const auth = {
      token: "alpha-secret",
      principal: { id: "alpha", kind: "bearer" }
    }
    expect(() => NodeControl.layerServerBearerAuth(auth, { host: "0.0.0.0", port: 0 })).toThrow(/--listen/)
    expect(() => NodeControl.layerServerNoopAuth({ host: "0.0.0.0", port: 0, listen: true })).toThrow(
      /permissive authentication/
    )
  })

  it("uses the bearer credential for the remote WebSocket projection", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function*() {
        const server = yield* HttpServer.HttpServer
        return yield* Effect.gen(function*() {
          const control = yield* ControlService.Control
          return yield* control.watch({}).pipe(Stream.runHead)
        }).pipe(
          Effect.provide(NodeControl.layerControl({ remote: addressUrl(server), credential: "alpha-secret" }))
        )
      }).pipe(
        Effect.provide(
          NodeControl.layerServerBearerAuth({
            token: "alpha-secret",
            principal: { id: "alpha", kind: "bearer" }
          }, { port: 0 }).pipe(
            Layer.provide(streamingControl)
          )
        ),
        Effect.scoped
      )
    )

    expect(events._tag).toBe("Some")
    if (events._tag === "Some") {
      expect(events.value).toEqual(websocketEvent)
    }
  })
})
