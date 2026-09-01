/**
 * Every command handler in the tree, driven through the real parser.
 *
 * `ControlSurface.test.ts` covers the plan/approve/run spine and the remote
 * transports. These cases cover the rest of the surface — the listing,
 * lifecycle, and projection verbs — plus the argument decoding that every verb
 * shares: bare keys, `key=value` pairs, `--data` merged over them, and the
 * `--json`/`--quiet` presentation flags that change what the other flags mean.
 */
import { NodeServices } from "@effect/platform-node"
import { Control as ControlService, type ControlSchema } from "@smthrs/control"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { TestConsole } from "effect/testing"
import { Command } from "effect/unstable/cli"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import { cli } from "../src/Command.ts"
import * as ExecutorOwnership from "../src/ExecutorOwnership.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Output from "../src/Output.ts"
import * as Project from "../src/Project.ts"
import { packageVersion } from "../src/Version.ts"

const runCommand = Command.runWith(cli, { version: packageVersion })

/** The lines one invocation logged, joined; empty when the verb printed nothing. */
const text = Effect.fnUntraced(function*(args: ReadonlyArray<string>) {
  const before = (yield* TestConsole.logLines).length
  yield* runCommand(args)
  const lines = yield* TestConsole.logLines
  return lines.slice(before).map(String).join("\n")
})

/** The decoded `--json` payload of one invocation. */
const json = Effect.fnUntraced(function*(args: ReadonlyArray<string>) {
  const rendered = yield* text(args)
  return yield* Effect.try({
    try: () => JSON.parse(rendered) as unknown,
    catch: (cause) => new Error(`command produced invalid JSON: ${String(cause)} (${rendered})`)
  })
})

/**
 * The project flow these cases plan, approve, and run.
 *
 * A reserved `system/*` id would be simpler to reach — `TestControl` falls
 * back to the whole reserved catalog — but the CLI refuses to plan one, since
 * a reserved id has no body and a launch would park forever
 * (`Unsupported.reservedFlowError`). So the fixture registers a flow of its
 * own, which is also what an operator's project looks like.
 */
const demoFlow = {
  flowId: "demo/ship",
  description: "The fixture flow these cases plan and run",
  deployClass: false,
  envelope: { capabilities: [], flows: [], budget: {} }
} as const

const testControl = TestControl.layer({ now: () => 0, flows: [demoFlow] })
// `memory` is part of the command tree, so every invocation carries its
// requirement. These cases have no local database, which is exactly the
// `--remote` situation, so they get the same refusing store a remote
// invocation gets rather than opening a `.flows/` beside the test run.
const services = Layer.mergeAll(TestConsole.layer, Output.layer, NodeControl.layerMemoryRemote)

const run = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  control: Layer.Layer<ControlService.Control, unknown, unknown>
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(control),
      Effect.provide(services),
      Effect.provide(NodeServices.layer)
    ) as Effect.Effect<A, E>
  )

/** Plans, approves, and launches `demo/ship`, returning the run identifier. */
const launch = Effect.fnUntraced(function*() {
  const card = (yield* json(["--json", "plan", "demo/ship"])) as { readonly approval: unknown }
  const approval = JSON.stringify(card.approval)
  yield* json(["--json", "approve", approval])
  const receipt = (yield* json(["--json", "run", approval])) as { readonly runId?: unknown }
  if (typeof receipt.runId !== "string") return yield* Effect.fail(new Error("run did not emit its identifier"))
  return { runId: receipt.runId, approval }
})

/** A control whose `watch` serves a fixed, finite history. */
const historyControl = (events: ReadonlyArray<ControlSchema.ControlEvent>) =>
  Layer.effect(
    ControlService.Control,
    Effect.gen(function*() {
      const control = yield* ControlService.Control
      return ControlService.make({ ...control, watch: () => Stream.fromIterable(events) })
    })
  ).pipe(Layer.provide(testControl))

const event = (
  sequence: number,
  kind: string,
  payload: unknown = null
): ControlSchema.ControlEvent => ({
  sequence,
  kind,
  runId: "run-1",
  occurredAt: sequence,
  payload: payload as ControlSchema.ControlEvent["payload"]
})

describe("input decoding", () => {
  it("splits pairs on the first separator and treats a bare key as a set flag", async () => {
    const card = await run(
      json(["--json", "plan", "demo/ship", "verbose", "a=1", "k=v=w"]),
      testControl
    )

    // A bare key is `true`, a pair keeps everything after the first `=`, and
    // the summary is the canonical form of exactly that decoded object.
    expect((card as { readonly inputSummary: string }).inputSummary).toBe(
      JSON.stringify({ a: "1", "k": "v=w", verbose: true })
    )
  })

  it("treats a leading separator as a bare key, not an empty name", async () => {
    const card = await run(json(["--json", "plan", "demo/ship", "=lead", "b="]), testControl)

    // `separator < 1` is the boundary: index 0 is a bare key, index 1 is the
    // shortest real pair and its value is the empty string.
    expect((card as { readonly inputSummary: string }).inputSummary).toBe(
      JSON.stringify({ "=lead": true, b: "" })
    )
  })

  it("plans with no pairs at all as the empty input object", async () => {
    const card = await run(json(["--json", "plan", "demo/ship"]), testControl)

    expect((card as { readonly inputSummary: string }).inputSummary).toBe("{}")
  })

  it("merges an object --data over the positional pairs", async () => {
    const card = await run(
      json(["--json", "plan", "demo/ship", "a=1", "b=2", "--data", "{\"a\":\"overridden\",\"c\":3}"]),
      testControl
    )

    // `--data` is applied last, so it wins the key it shares with a pair.
    expect((card as { readonly inputSummary: string }).inputSummary).toBe(
      JSON.stringify({ a: "overridden", b: "2", c: 3 })
    )
  })

  it.each(
    [
      ["an array", "[1,2]", [1, 2]],
      ["a scalar", "7", 7],
      ["null", "null", null]
    ] as const
  )("nests %s --data under `data` beside the pairs", async (_label, serialized, expected) => {
    const card = await run(
      json(["--json", "plan", "demo/ship", "a=1", "--data", serialized]),
      testControl
    )

    expect((card as { readonly inputSummary: string }).inputSummary).toBe(
      JSON.stringify({ a: "1", data: expected })
    )
  })

  it("plans the empty flow id when the variadic argument list is empty", async () => {
    const error = await run(Effect.flip(runCommand(["--json", "plan"])), testControl)

    // `input[0] ?? ""` is the boundary: no argument is an empty flow id, and
    // the control plane refuses it rather than the parser guessing.
    expect(String(error)).toContain("Flow")
  })
})

describe("presentation flags", () => {
  it("renders human output as indented JSON when --json is absent", async () => {
    const rendered = await run(text(["plan", "demo/ship"]), testControl)

    expect(rendered).toContain("\n  \"flowId\": \"demo/ship\"")
  })

  it("prints nothing at all under --quiet while still performing the mutation", async () => {
    const result = await run(
      Effect.gen(function*() {
        const quiet = yield* text(["--json", "--quiet", "plan", "demo/ship"])
        const loud = yield* text(["--json", "plan", "demo/ship"])
        return { quiet, loud }
      }),
      testControl
    )

    expect(result.quiet).toBe("")
    expect(JSON.parse(result.loud)).toMatchObject({ flowId: "demo/ship" })
  })
})

describe("listing verbs", () => {
  it("lists flows", async () => {
    const listed = await run(json(["--json", "ls"]), testControl)

    expect(listed).toMatchObject({ _tag: "flows" })
  })

  it("lists runs with no filters and with both filters applied", async () => {
    const result = await run(
      Effect.gen(function*() {
        const launched = yield* launch()
        const all = yield* json(["--json", "ps"])
        const matching = yield* json(["--json", "ps", "--flow", "demo/ship", "--status", "accepted"])
        const wrongStatus = yield* json(["--json", "ps", "--flow", "demo/ship", "--status", "failed"])
        const wrongFlow = yield* json(["--json", "ps", "--flow", "system/other", "--status", "accepted"])
        return { runId: launched.runId, all, matching, wrongStatus, wrongFlow }
      }),
      testControl
    )

    // Both filters are conjunctive: either one alone disagreeing empties the
    // listing that the pair together matches.
    expect(result.all).toMatchObject({ _tag: "runs", items: [{ runId: result.runId }] })
    expect(result.matching).toMatchObject({ _tag: "runs", items: [{ runId: result.runId }] })
    expect(result.wrongStatus).toEqual({ _tag: "runs", items: [] })
    expect(result.wrongFlow).toEqual({ _tag: "runs", items: [] })
  })
})

describe("lifecycle verbs", () => {
  it("cancels a launched run and reports the terminal status", async () => {
    const result = await run(
      Effect.gen(function*() {
        const launched = yield* launch()
        const receipt = yield* json(["--json", "cancel", launched.runId])
        const listed = yield* json(["--json", "ps"])
        return { receipt, listed }
      }),
      testControl
    )

    // Cancellation is synchronous here, so the receipt already reports the
    // terminal status the listing then shows.
    expect(result.receipt).toMatchObject({ _tag: "Terminal", status: "cancelled" })
    expect(result.listed).toMatchObject({ _tag: "runs", items: [{ status: "cancelled" }] })
  })

  it("answers a repeated cancel from the run rather than from its receipt", async () => {
    const result = await run(
      Effect.gen(function*() {
        const launched = yield* launch()
        const first = yield* json(["--json", "cancel", launched.runId])
        const second = yield* json(["--json", "cancel", launched.runId])
        return { first, second }
      }),
      testControl
    )

    // Retargeted: the key is derived from the run id alone, so a repeated
    // cancel used to replay the first one's receipt as `AlreadyApplied`. That
    // is the right answer only while the receipt is still true, and a cancel
    // that finished nothing leaves a non-terminal run behind — the Phase 7
    // smoke's `cancel` and `down` both replayed against two runs no command
    // could reach. `cancel` reads the run first now, so a settled run answers
    // `Terminal` every time and a live one is asked again.
    expect(result.first).toMatchObject({ _tag: "Terminal", status: "cancelled" })
    expect(result.second).toMatchObject({ _tag: "Terminal", status: "cancelled" })
  })

  it("answers a repeated resume from the run rather than from its receipt", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const launched = yield* launch()
        const first = yield* json(["--json", "run", launched.runId, "--resume"])
        yield* json(["--json", "cancel", launched.runId])
        const second = yield* json(["--json", "run", launched.runId, "--resume"])
        return { first, second }
      }).pipe(
        Effect.timeout("20 seconds"),
        // A remote CLI owns no driver, so the receipt is the whole answer and
        // the settlement wait is out of the way of what this asks.
        Effect.provide(ExecutorOwnership.layer(false)),
        Effect.provide(testControl),
        Effect.provide(services),
        Effect.provide(NodeServices.layer)
      )
    )

    // The key is `cli:resume:<runId>` when no park was ever committed, so the
    // second call reuses the first one's receipt. Replaying it answered
    // `AlreadyApplied` for a run that had since been cancelled: the Phase 7
    // smoke got that answer for `run --resume` against a completed run and for
    // `approve` against another, and neither says anything about the run.
    expect(result.first).toMatchObject({ _tag: "Accepted" })
    expect(result.second).toMatchObject({ _tag: "Terminal", status: "cancelled" })
  })

  it("delivers a named JSON signal to a run", async () => {
    const receipt = await run(
      Effect.gen(function*() {
        const launched = yield* launch()
        return yield* json([
          "--json",
          "signal",
          launched.runId,
          "{\"name\":\"proceed\",\"payload\":{\"answer\":42}}"
        ])
      }),
      testControl
    )

    expect(receipt).toMatchObject({ _tag: "Accepted" })
  })

  it("rejects a signal payload that parses but does not match the schema", async () => {
    const error = await run(
      Effect.flip(runCommand(["signal", "run-1", "{\"name\":\"proceed\"}"])),
      testControl
    )

    expect(error).toBeInstanceOf(CliError.UsageError)
    expect((error as CliError.UsageError).message).toBe("signal-json must match the expected payload schema")
  })

  it("denies a complete approval payload", async () => {
    const receipt = await run(
      Effect.gen(function*() {
        const card = (yield* json(["--json", "plan", "demo/ship"])) as { readonly approval: unknown }
        return yield* json(["--json", "deny", JSON.stringify(card.approval)])
      }),
      testControl
    )

    expect(receipt).toMatchObject({ _tag: "Accepted" })
  })

  it("refuses to run an in-run node approval payload", async () => {
    const payload = JSON.stringify({
      target: {
        _tag: "Node",
        runId: "run-1",
        requestId: "request-1",
        digest: "digest-1",
        envelope: { capabilities: [], flows: [], budget: {} }
      },
      scope: "run",
      idempotencyKey: "approve:node-1"
    })
    const error = await run(Effect.flip(runCommand(["run", payload])), testControl)

    expect(error).toBeInstanceOf(CliError.UsageError)
    expect((error as CliError.UsageError).message).toBe("run requires a plan approval payload")
    expect(CliError.exitCode(error as CliError.UsageError)).toBe(2)
  })
})

describe("up", () => {
  it("plans, approves for the run, and launches in one command", async () => {
    const receipt = await run(json(["--json", "up", "demo/ship"]), testControl)

    // One command, one receipt: the plan and its approval are internal to the
    // verb, and the caller reads the run id off the receipt because rc.0 has
    // no operator-supplied run id (rc-contract section 4.1).
    expect(receipt).toMatchObject({ _tag: "Accepted" })
    expect(typeof (receipt as { readonly runId: string }).runId).toBe("string")
  })

  it("carries --data into the planned input", async () => {
    const card = await run(json(["--json", "plan", "demo/ship", "--data", "{\"topic\":\"flows\"}"]), testControl)

    expect(card).toMatchObject({ flowId: "demo/ship" })
    expect((card as { readonly inputSummary: string }).inputSummary).toBe(JSON.stringify({ topic: "flows" }))
  })
})

describe("forensic projections", () => {
  it("renders the human status card for one run and the raw listing under --json", async () => {
    const result = await run(
      Effect.gen(function*() {
        const launched = yield* launch()
        const card = yield* text(["status", launched.runId])
        const raw = yield* json(["--json", "status", launched.runId])
        return { runId: launched.runId, card, raw }
      }),
      testControl
    )

    // `--json` keeps the stable listing shape; the human reader gets the
    // diagnosis computed from the run's own events.
    expect(result.card).toContain("Verdict")
    expect(result.card).toContain(`Next      smithers logs ${result.runId}`)
    expect(result.raw).toMatchObject({ _tag: "runs", items: [{ runId: result.runId }] })
  })

  it("renders the whole listing when no run id is given, in either format", async () => {
    const result = await run(
      Effect.gen(function*() {
        yield* launch()
        const human = yield* text(["status"])
        const raw = yield* json(["--json", "status"])
        return { human, raw }
      }),
      testControl
    )

    // Without a run id there is nothing to diagnose, so the human form is the
    // indented listing rather than a card.
    expect(result.human).toContain("\"_tag\": \"runs\"")
    expect(result.raw).toMatchObject({ _tag: "runs" })
  })

  it("diagnoses without a summary when the listing answers with the wrong shape", async () => {
    const mismatched = Layer.effect(
      ControlService.Control,
      Effect.gen(function*() {
        const control = yield* ControlService.Control
        return ControlService.make({
          ...control,
          list: () => Effect.succeed({ _tag: "flows", items: [] })
        })
      })
    ).pipe(Layer.provide(testControl))
    const card = await run(text(["status", "run-1"]), mismatched)

    // A control plane that answers a run query with a flow listing has no
    // summary to project, so the card degrades instead of throwing.
    expect(card).toContain("Verdict   unlaunched")
    expect(card).toContain("Run       ? · 0s")
  })

  it("renders a run that does not exist as an empty diagnosis rather than failing", async () => {
    const card = await run(text(["status", "run-missing"]), testControl)

    // Nothing matched the listing, so the card has no summary to name and
    // falls back to `?` instead of inventing the requested identifier.
    expect(card).toContain("Verdict   unlaunched")
    expect(card).toContain("Run       ? · 0s")
    expect(card).toContain("Activity  0 turns · 0 calls (0 refused, 0 duplicate) · edits 0/0")
  })

  it("projects a finite history as a transcript for humans and as raw events under --json", async () => {
    const history = historyControl([
      event(1, "control.run.running", { runId: "run-1", status: "running" }),
      event(2, "control.agent.turn-opened", { seat: "anthropic:claude-sonnet-4-5" }),
      event(3, "control.run.completed", { runId: "run-1", status: "completed" })
    ])
    const result = await run(
      Effect.gen(function*() {
        const transcript = yield* text(["logs", "run-1"])
        const raw = yield* json(["--json", "logs", "run-1"])
        return { transcript, raw }
      }),
      history
    )

    expect(result.transcript).toContain("=== turn 1 · anthropic:claude-sonnet-4-5 ===")
    expect(result.transcript).toContain("run-1 · completed")
    expect(Array.isArray(result.raw)).toBe(true)
    expect((result.raw as ReadonlyArray<unknown>).length).toBe(3)
  })

  it("renders one line per event as it lands under --follow, in either format", async () => {
    const history = historyControl([
      event(1, "control.agent.cell-produced", { text: "return 1" }),
      event(2, "control.run.completed", { runId: "run-1", status: "completed" })
    ])
    const result = await run(
      Effect.gen(function*() {
        const human = yield* text(["logs", "run-1", "--follow"])
        const raw = yield* text(["--json", "logs", "run-1", "--follow"])
        return { human, raw }
      }),
      history
    )

    // Follow mode renders per event, so two events are two rendered lines in
    // both formats — never the whole-run transcript.
    expect(result.human.split("\n")).toEqual([
      "cell    return 1",
      "control.run.completed {\"runId\":\"run-1\",\"status\":\"completed\"}"
    ])
    expect(result.raw.split("\n").length).toBe(2)
    expect(JSON.parse(result.raw.split("\n")[0]!)).toMatchObject({ kind: "control.agent.cell-produced" })
  })

  it("reads every run's events when no run id is given", async () => {
    const history = historyControl([event(1, "control.run.running", { runId: "run-1", status: "running" })])
    const raw = await run(json(["--json", "logs"]), history)

    expect((raw as ReadonlyArray<unknown>).length).toBe(1)
  })
})

describe("owned-run settlement", () => {
  const failingWatch = Layer.effect(
    ControlService.Control,
    Effect.gen(function*() {
      const control = yield* ControlService.Control
      return ControlService.make({
        ...control,
        resume: (input) => Effect.succeed({ _tag: "Accepted", receiptId: input.idempotencyKey, runId: "run-1" }),
        watch: () => Stream.fail(new Error("transport gone") as never)
      })
    })
  ).pipe(Layer.provide(testControl))

  it("keys a resume to the run alone when no park was ever committed", async () => {
    const receipt = await Effect.runPromise(
      json(["--json", "run", "run-1", "--resume"]).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(ExecutorOwnership.layer(true)),
        Effect.provide(failingWatch),
        Effect.provide(services),
        Effect.provide(NodeServices.layer)
      )
    )

    // A failed history read is not a failed resume: the park lookup degrades
    // to "no park", the key drops its sequence suffix, and the settlement wait
    // closes instead of hanging the process.
    expect(receipt).toMatchObject({ _tag: "Accepted", receiptId: "cli:resume:run-1" })
  })

  it("does not wait on settlement when this process does not own the executor", async () => {
    const receipt = await Effect.runPromise(
      json(["--json", "run", "run-1", "--resume"]).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(ExecutorOwnership.layer(false)),
        Effect.provide(failingWatch),
        Effect.provide(services),
        Effect.provide(NodeServices.layer)
      )
    )

    expect(receipt).toMatchObject({ _tag: "Accepted" })
  })

  it("stops the settlement wait at the first settling event kind", async () => {
    const settlements = [
      "control.run.waiting-approval",
      "control.run.pending",
      "control.run.completed",
      "control.run.failed",
      "control.run.cancelled"
    ] as const
    const results = await Promise.all(settlements.map((kind) =>
      Effect.runPromise(
        Effect.exit(json(["--json", "run", "run-1", "--resume"])).pipe(
          Effect.timeout("5 seconds"),
          Effect.provide(ExecutorOwnership.layer(true)),
          Effect.provide(
            Layer.effect(
              ControlService.Control,
              Effect.gen(function*() {
                const control = yield* ControlService.Control
                return ControlService.make({
                  ...control,
                  resume: (input) =>
                    Effect.succeed({ _tag: "Accepted", receiptId: input.idempotencyKey, runId: "run-1" }),
                  watch: (filter) =>
                    filter.follow === false
                      ? Stream.empty
                      : Stream.make(event(1, "control.agent.turn-opened", { seat: "s" }), event(2, kind)).pipe(
                        Stream.concat(Stream.never)
                      )
                })
              })
            ).pipe(Layer.provide(testControl))
          ),
          Effect.provide(services),
          Effect.provide(NodeServices.layer)
        )
      )
    ))

    // Every settlement kind releases the wait; a non-settling event before it
    // does not. `control.run.pending` releases it with the executor's refusal
    // rather than the launch receipt: the run is durable and stopped.
    for (const [index, exit] of results.entries()) {
      const kind = settlements[index]!
      if (kind === "control.run.pending") {
        expect(Exit.isFailure(exit)).toBe(true)
        // Restated 2026-08-31: the refusal used to read "the executor did not
        // take it"; it now names the cause and both ways forward.
        expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : "")).toContain(
          "no executor took it"
        )
        continue
      }
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(Exit.isSuccess(exit) ? exit.value : undefined).toMatchObject({ _tag: "Accepted" })
    }
  })
})

describe("exit statuses", () => {
  it("gives a parked receipt exit status 3 and an accepted one status 0", async () => {
    const result = await run(
      Effect.gen(function*() {
        const card = (yield* json(["--json", "plan", "demo/ship"])) as { readonly approval: unknown }
        const approval = JSON.stringify(card.approval)
        const parked = yield* json(["--json", "run", approval])
        yield* json(["--json", "approve", approval])
        const accepted = yield* json(["--json", "run", approval])
        return { parked, accepted }
      }),
      testControl
    )

    expect(Output.exitCode(result.parked)).toBe(3)
    expect(Output.exitCode(result.accepted)).toBe(0)
  })

  it("fails an unknown subcommand as a parse error, not a control call", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(runCommand(["nope"])).pipe(
        Effect.provide(testControl),
        Effect.provide(services),
        Effect.provide(NodeServices.layer)
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(String(Cause.squash(exit.cause))).not.toContain("demo/ship")
    }
  })
})

describe("`gc` over a database it cannot open", () => {
  it("names the file and fails, instead of rendering an empty sweep and exiting 0", async () => {
    // `gc --dry-run` is trusted to name exactly what a real pass would delete.
    // A file it could not even open rendered as `{ runs: [], deleted: {} }`
    // with exit 0, which reads as "there is nothing to collect".
    const root = mkdtempSync(join(tmpdir(), "smithers-gc-handler-"))
    try {
      mkdirSync(join(root, ".flows"), { recursive: true })
      writeFileSync(join(root, ".flows", "control.db"), "not a database at all")

      const exit = await Effect.runPromise(
        Effect.exit(runCommand(["gc", "--dry-run", "--json"])).pipe(
          Effect.provide(testControl),
          Effect.provide(services),
          // The migration root defaults the way `NodeControl` defaults it when a
          // configuration names none, so this drives the layer the CLI builds.
          Effect.provide(Project.layer(root, Project.legacyRoot(undefined, root))),
          Effect.provide(NodeServices.layer)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(error).toBeInstanceOf(CliError.UnsupportedError)
      expect((error as CliError.UnsupportedError).message).toContain(join(root, ".flows", "control.db"))
      expect(CliError.exitCode(error as CliError.UnsupportedError)).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("deciding an in-run approval from the CLI", () => {
  const nodePayload = (runId: string) =>
    JSON.stringify({
      target: {
        _tag: "Node",
        runId,
        requestId: "request-1",
        digest: "digest-1",
        envelope: { capabilities: [], flows: [], budget: {} }
      },
      scope: "run",
      idempotencyKey: `approve:${runId}`
    })

  /**
   * A control whose run settles only while somebody is watching it.
   *
   * That is what a local executor is: `Control.approve` resumes the parked run
   * server-side, and the driver that picks the resume up lives exactly as long
   * as the process that opened it. A command that prints its receipt and
   * returns takes the driver down with it, so the run it just restarted stops
   * where it stood.
   *
   * The committed park is served as history so the wait has to be scoped past
   * it: `control.run.waiting-approval` is itself a settling kind, and a wait
   * that replayed it would return without ever driving the run.
   */
  const settlingControl = (state: { status: string; runs: number }) =>
    Layer.effect(
      ControlService.Control,
      Effect.gen(function*() {
        const control = yield* ControlService.Control
        const decided = (input: ControlService.ApprovalInput): ControlSchema.Receipt =>
          input.target._tag === "Node"
            ? { _tag: "Accepted", receiptId: input.idempotencyKey, runId: input.target.runId }
            : { _tag: "Accepted", receiptId: input.idempotencyKey }
        return ControlService.make({
          ...control,
          run: (input) => {
            state.runs += 1
            return control.run(input)
          },
          approve: (input) => Effect.succeed(decided(input)),
          deny: (input) => Effect.succeed(decided(input)),
          watch: (filter) => {
            const history = (filter.afterSequence ?? 0) < 1
              ? [event(1, "control.run.waiting-approval")]
              : []
            if (filter.follow === false) return Stream.fromIterable(history)
            return Stream.fromIterable(history).pipe(
              Stream.concat(Stream.fromEffect(
                Effect.delay(
                  Effect.sync(() => {
                    state.status = "completed"
                    return event(2, "control.run.completed")
                  }),
                  "20 millis"
                )
              )),
              Stream.concat(Stream.never)
            )
          }
        })
      })
    ).pipe(Layer.provide(testControl))

  const decide = (verb: "approve" | "deny") => json(["--json", verb, nodePayload("run-1")])

  it.each(["approve", "deny"] as const)("settles a parked run on %s alone", async (verb) => {
    const state = { status: "waiting-approval", runs: 0 }
    const receipt = await Effect.runPromise(
      decide(verb).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(ExecutorOwnership.layer(true)),
        Effect.provide(settlingControl(state)),
        Effect.provide(services),
        Effect.provide(NodeServices.layer)
      )
    )

    // rc-contract §5.1: the decision resumes the run, so one call settles it.
    expect(receipt).toMatchObject({ _tag: "Accepted", runId: "run-1" })
    expect(state.status).toBe("completed")
    // And it settles through the decision, not through a second verb.
    expect(state.runs).toBe(0)
  })

  it("does not wait on a decision when this process does not own the executor", async () => {
    const state = { status: "waiting-approval", runs: 0 }
    const receipt = await Effect.runPromise(
      decide("approve").pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(ExecutorOwnership.layer(false)),
        Effect.provide(settlingControl(state)),
        Effect.provide(services),
        Effect.provide(NodeServices.layer)
      )
    )

    // A remote CLI owns no driver; the server it called owns the resume.
    expect(receipt).toMatchObject({ _tag: "Accepted" })
    expect(state.status).toBe("waiting-approval")
  })
})

describe("signal idempotency", () => {
  /** Records the mutation key each `signal` invocation minted. */
  const recordingSignals = (keys: Array<string>) =>
    Layer.effect(
      ControlService.Control,
      Effect.gen(function*() {
        const control = yield* ControlService.Control
        return ControlService.make({
          ...control,
          signal: (input) =>
            Effect.sync(() => {
              keys.push(input.idempotencyKey)
              return { _tag: "Accepted", receiptId: input.idempotencyKey, runId: input.runId }
            })
        })
      })
    ).pipe(Layer.provide(testControl))

  it("mints one mutation per signal payload", async () => {
    const keys: Array<string> = []
    await run(
      Effect.gen(function*() {
        yield* json(["--json", "signal", "run-1", "{\"name\":\"first\",\"payload\":null}"])
        yield* json(["--json", "signal", "run-1", "{\"name\":\"second\",\"payload\":null}"])
      }),
      recordingSignals(keys)
    )

    // rc-contract §5.1: two different signals to one run are two mutations. A
    // key that named the run alone replayed the first receipt for the second
    // signal, and the second signal was never delivered.
    expect(new Set(keys).size).toBe(2)
    expect(keys.every((key) => key.startsWith("cli:signal:run-1:"))).toBe(true)
  })

  it("replays one mutation for the same signal sent twice", async () => {
    const keys: Array<string> = []
    await run(
      Effect.gen(function*() {
        yield* json(["--json", "signal", "run-1", "{\"name\":\"first\",\"payload\":null}"])
        yield* json(["--json", "signal", "run-1", "{\"name\":\"first\",\"payload\":null}"])
      }),
      recordingSignals(keys)
    )

    expect(new Set(keys).size).toBe(1)
  })
})
