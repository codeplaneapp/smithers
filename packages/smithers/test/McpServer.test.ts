/**
 * The `smthrs --mcp` tool surface, its serve loop, and one real stdio round trip.
 *
 * The round trip runs `@smthrs/mcp`'s own client against a spawned
 * `smthrs --mcp`, so the framing, the handshake, and the envelope are proven
 * by the code that consumes them rather than by a reimplementation.
 */
import { NodeServices } from "@effect/platform-node"
import { Control as ControlService, ControlError, ControlRuntime } from "@smthrs/control"
import * as TestControl from "@smthrs/control/test/TestControl"
import * as McpClient from "@smthrs/mcp/McpClient"
import { Cause, Effect, Exit, Layer, Schema, Stream } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import * as McpServer from "../src/McpServer.ts"
import * as Verb from "../src/Verb.ts"

const entry = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const staged: Array<string> = []

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

const control = TestControl.layer({ now: () => 0 })

const callWith = <E>(
  provided: Layer.Layer<ControlService.Control, E>,
  tool: McpServer.Tool,
  args: Record<string, unknown> = {}
) => Effect.runPromise(tool.call(args).pipe(Effect.provide(provided)))

const call = (tool: McpServer.Tool, args: Record<string, unknown> = {}) => callWith(control, tool, args)

const rpcCallWith = async <E>(
  provided: Layer.Layer<ControlService.Control, E>,
  name: string,
  args: Record<string, unknown> = {}
): Promise<McpServer.Envelope> => {
  const reply = await Effect.runPromise(
    McpServer.respond(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } as never,
      McpServer.tools(),
      "1.0.0-rc.0"
    ).pipe(Effect.provide(provided))
  ) as { readonly result: { readonly structuredContent: McpServer.Envelope } }
  return reply.result.structuredContent
}

const rpcCall = (name: string, args: Record<string, unknown> = {}) => rpcCallWith(control, name, args)

const find = (name: string) =>
  McpServer.tools({ surface: "both", verbs: Verb.shipped })
    .find((tool) => tool.name === name)!

describe("the tool surface", () => {
  it("exposes the eleven Control-backed tools by their 0.x names", () => {
    expect(McpServer.supportedTools.map((tool) => tool.name)).toEqual([
      "list_workflows",
      "run_workflow",
      "list_runs",
      "get_run",
      "watch_run",
      "get_run_events",
      "explain_run",
      "list_pending_approvals",
      "resolve_approval",
      "get_node_detail",
      "get_chat_transcript"
    ])
  })

  it("keeps the ten unsupported names, answering with a reason", () => {
    // Removing them would make an agent's call fail as "unknown tool", which
    // reads as a client bug rather than as a missing release feature.
    expect(McpServer.unsupportedTools.map((tool) => tool.name)).toEqual([
      "revert_attempt",
      "fork_run",
      "replay_run",
      "rewind_run",
      "restore_checkpoint",
      "list_snapshots",
      "get_timeline",
      "time_travel",
      "list_artifacts",
      "ask_human"
    ])
  })

  it("defaults to the semantic surface, all twenty-one tools", () => {
    expect(McpServer.tools().map((tool) => tool.name)).toHaveLength(21)
  })

  it("mirrors the shipped verbs on the raw surface", () => {
    const raw = McpServer.tools({ surface: "raw", verbs: Verb.shipped })

    expect(raw).toHaveLength(Verb.shipped.length)
    expect(raw.map((tool) => tool.name)).toContain("cli_ps")
    expect(raw.find((tool) => tool.name === "cli_ps")?.description).toContain("smthrs ps")
    expect(McpServer.tools({ surface: "both", verbs: Verb.shipped })).toHaveLength(21 + Verb.shipped.length)
  })

  it("scopes a session to an allowlist and to read-only tools", () => {
    expect(McpServer.tools({ allowedTools: ["get_run", "run_workflow"] }).map((tool) => tool.name))
      .toEqual(["run_workflow", "get_run"])
    expect(McpServer.tools({ readOnly: true }).map((tool) => tool.name))
      .not.toContain("run_workflow")
    expect(McpServer.tools({ readOnly: true }).map((tool) => tool.name)).toContain("get_run")
  })

  it("advertises closed object schemas for every tool", () => {
    for (const tool of McpServer.tools({ surface: "both", verbs: Verb.shipped })) {
      expect([tool.name, tool.inputSchema]).toEqual([
        tool.name,
        expect.objectContaining({ type: "object", additionalProperties: false })
      ])
    }
  })
})

describe("the envelope", () => {
  it("answers every unsupported tool with `unsupported` and a reason", async () => {
    for (const tool of McpServer.unsupportedTools) {
      const result = await call(tool)

      expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } })
      expect((result as { readonly error: { readonly message: string } }).error.message)
        .toContain("is not available in 1.0.0-rc.0")
    }
  })

  it("explains why `ask_human` has no replacement", () => {
    const reason = McpServer.unsupportedReasons.find(([name]) => name === "ask_human")?.[1]

    expect(reason).toContain("approvals park the run")
    expect(reason).toContain("list_pending_approvals")
  })

  it("lists flows, runs, and one run's events over the control plane", async () => {
    expect(await call(find("list_workflows"))).toMatchObject({ ok: true })
    expect(await call(find("list_runs"), { flowId: "system/test", status: "running" })).toMatchObject({ ok: true })
  })

  it("omits reserved system flows from the workflow catalog", async () => {
    const result = await call(find("list_workflows")) as {
      readonly ok: true
      readonly data: ReadonlyArray<{
        readonly flowId: string
      }>
    }

    expect(result.data.map((flow) => flow.flowId)).not.toContain("system/test")
    expect(result.data.map((flow) => flow.flowId)).not.toContain("system/release")
  })

  it("refuses a reserved workflow before asking the control plane to plan it", async () => {
    let planCalls = 0
    const recordingControl = Layer.effect(
      ControlService.Control,
      Effect.map(ControlService.Control, (service) =>
        ControlService.make({
          ...service,
          plan: (input) => {
            planCalls += 1
            return service.plan(input)
          }
        }))
    ).pipe(Layer.provide(control))

    const result = await callWith(recordingControl, find("run_workflow"), { flowId: "system/release" })

    expect(result).toMatchObject({ ok: false, error: { code: "unsupported" } })
    expect((result as { readonly error: { readonly message: string } }).error.message)
      .toContain("system/release is a reserved system flow id")
    expect(planCalls).toBe(0)
  })

  it("validates the run status and names every accepted value", async () => {
    const refused = await rpcCall("list_runs", { status: "done" })

    expect(refused).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } })
    const message = (refused as { readonly error: { readonly message: string } }).error.message
    expect(message).toContain("status")
    for (
      const status of [
        "accepted",
        "running",
        "parked",
        "waiting-approval",
        "cancelled",
        "completed",
        "failed"
      ]
    ) expect(message).toContain(status)

    expect(await rpcCall("list_runs", { status: "running" })).toMatchObject({ ok: true })
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses the watch cursor %s", async (afterSequence) => {
    const result = await rpcCall("watch_run", { runId: "run-1", afterSequence })

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } })
    expect((result as { readonly error: { readonly message: string } }).error.message)
      .toContain("afterSequence")
  })

  it("refuses a non-object workflow input", async () => {
    const result = await rpcCall("run_workflow", { flowId: "project/demo", input: "not-an-object" })

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } })
    expect((result as { readonly error: { readonly message: string } }).error.message).toContain("input")
  })

  it("refuses members that the advertised schema does not declare", async () => {
    const result = await rpcCall("list_runs", { unexpected: true })

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } })
    expect((result as { readonly error: { readonly message: string } }).error.message).toContain("unexpected")
  })

  it("names a missing argument rather than failing the call", async () => {
    for (const name of ["get_run", "watch_run", "get_run_events", "explain_run", "get_chat_transcript"]) {
      expect(await call(find(name))).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } })
    }
    expect(await call(find("run_workflow"))).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } })
    expect(await call(find("get_node_detail"), { runId: "run-1" }))
      .toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } })
    expect(await call(find("resolve_approval"), { approval: "{", decision: "approve" }))
      .toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } })
  })

  it("refuses a decision it does not recognise", async () => {
    const result = await call(find("resolve_approval"), {
      approval: {
        target: { _tag: "Plan", planId: "p", digest: "d", envelope: { capabilities: [], flows: [], budget: {} } },
        idempotencyKey: "k"
      },
      decision: "maybe"
    })

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } })
  })

  /**
   * The scope decides how long a capability grant outlives the ask, so an
   * unreadable one may never be resolved by guessing. `run` is the widest
   * scope a single call can install, and coercing silence into it hands an
   * MCP client the whole run's capabilities for an argument it never sent.
   */
  const approveWithScope = (scope: Record<string, unknown>) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* ControlService.Control
        const runtime = yield* ControlRuntime.ControlRuntime
        const card = yield* service.plan({ flowId: "system/test", input: {} })
        const result = yield* find("resolve_approval").call({
          approval: { ...card.approval, idempotencyKey: "mcp:scope" },
          decision: "approve",
          ...scope
        })
        const grants = yield* runtime.grants
        return { result, scopes: grants.map((grant) => grant.scope) }
      }).pipe(Effect.provide(control), Effect.orDie)
    )

  it("grants an omitted approval scope once, never for the whole run", async () => {
    const observed = await approveWithScope({})

    expect(observed.result).toMatchObject({ ok: true })
    expect(observed.scopes).toEqual(["once"])
  })

  it("keeps an explicit approval scope", async () => {
    expect((await approveWithScope({ scope: "remembered" })).scopes).toEqual(["remembered"])
  })

  it("refuses an approval scope it does not recognise instead of widening it", async () => {
    for (const scope of ["onceX", "forever", "", 7, null]) {
      const observed = await approveWithScope({ scope })

      expect([scope, observed.result]).toEqual([scope, {
        ok: false,
        error: { code: "INVALID_INPUT", message: "scope must be \"once\", \"run\", or \"remembered\"" }
      }])
      expect([scope, observed.scopes]).toEqual([scope, []])
    }
  })

  it("reports a run the control plane does not know", async () => {
    expect(await call(find("get_run"), { runId: "absent" }))
      .toMatchObject({ ok: false, error: { code: "RUN_NOT_FOUND" } })
    expect(await call(find("get_node_detail"), { runId: "absent", nodeId: "read#1" }))
      .toMatchObject({ ok: false, error: { code: "NODE_NOT_FOUND" } })
  })

  it("uses a tagged control failure's stable code", async () => {
    expect(await call(find("run_workflow"), { flowId: "project/missing" }))
      .toMatchObject({ ok: false, error: { code: "FLOW_NOT_FOUND" } })
  })

  it("does not echo a credential from a tagged failure message", async () => {
    const credential = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"
    const refusingControl = Layer.effect(
      ControlService.Control,
      Effect.map(ControlService.Control, (service) =>
        ControlService.make({
          ...service,
          list: () => Effect.fail(new ControlError.Unauthorized({ message: `Bearer ${credential}` }))
        }))
    ).pipe(Layer.provide(control))

    const result = await rpcCallWith(refusingControl, "list_runs")
    const error = (result as { readonly error: { readonly code: string; readonly message: string } }).error

    expect(error.code).toBe("UNAUTHORIZED")
    expect(error.message).toBe("The control operation was not authorized")
    expect(error.message).not.toContain(credential)
  })

  it("maps every typed control failure to a stable public category", async () => {
    const secret = "Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"
    const cases = [
      [new ControlError.RunNotFound({ runId: "run" }), "RUN_NOT_FOUND"],
      [new ControlError.PlanNotFound({ planId: "plan" }), "PLAN_NOT_FOUND"],
      [new ControlError.PlanDenied({ planId: "plan" }), "PLAN_DENIED"],
      [new ControlError.FlowNotFound({ flowId: "flow" }), "FLOW_NOT_FOUND"],
      [
        new ControlError.PlanDigestMismatch({ planId: "plan", expected: secret, actual: secret }),
        "PLAN_DIGEST_MISMATCH"
      ],
      [new ControlError.EnvelopeMismatch({ planId: "plan", expected: secret, actual: secret }), "ENVELOPE_MISMATCH"],
      [new ControlError.ClaimLost({ runId: "run" }), "CLAIM_LOST"],
      [new ControlError.AlreadyResolved({ requestId: "request" }), "ALREADY_RESOLVED"],
      [new ControlError.InvalidInput({ issue: `input.path: ${secret}` }), "INVALID_INPUT"],
      [new ControlError.Unauthorized({ message: secret }), "UNAUTHORIZED"],
      [new ControlError.Unavailable({ feature: "watch", ticket: "T-1" }), "UNAVAILABLE"],
      [new ControlError.TransportError({ message: secret, retryable: true }), "TRANSPORT_ERROR"],
      [new ControlError.PersistenceError({ operation: "list", message: secret }), "PERSISTENCE_ERROR"],
      [new ControlError.LaunchFailed({ runId: "run", message: secret }), "LAUNCH_FAILED"],
      [new ControlError.NoMatchingWait({ runId: "run", waitName: "wake" }), "NO_MATCHING_WAIT"],
      [
        new ControlError.CredentialConflict({ id: "credential", expectedVersion: 1, actualVersion: 2 }),
        "CREDENTIAL_CONFLICT"
      ]
    ] as const

    for (const [failure, code] of cases) {
      const refusingControl = Layer.effect(
        ControlService.Control,
        Effect.map(
          ControlService.Control,
          (service) => ControlService.make({ ...service, list: () => Effect.fail(failure) })
        )
      ).pipe(Layer.provide(control))
      const result = await rpcCallWith(refusingControl, "list_runs")
      const error = (result as { readonly error: { readonly code: string; readonly message: string } }).error

      expect(error.code).toBe(code)
      expect(error.message).not.toContain(secret)
      expect([...error.message].length).toBeLessThanOrEqual(1024)
    }
  })

  it("propagates a control defect out of respond", async () => {
    const defectiveControl = Layer.effect(
      ControlService.Control,
      Effect.map(ControlService.Control, (service) =>
        ControlService.make({
          ...service,
          list: () => Effect.die(new Error("list invariant failed"))
        }))
    ).pipe(Layer.provide(control))

    await expect(rpcCallWith(defectiveControl, "list_runs")).rejects.toThrow("list invariant failed")
  })

  it("preserves interruption instead of turning shutdown into a tool response", async () => {
    const interruptedControl = Layer.effect(
      ControlService.Control,
      Effect.map(ControlService.Control, (service) => ControlService.make({ ...service, list: () => Effect.interrupt }))
    ).pipe(Layer.provide(control))
    const exit = await Effect.runPromiseExit(
      McpServer.respond(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_runs", arguments: {} }
        } as never,
        McpServer.tools(),
        "1.0.0-rc.0"
      ).pipe(Effect.provide(interruptedControl))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  })

  it("refuses an MCP history that crosses its encoded resource budget", async () => {
    const oversized = {
      sequence: 1,
      kind: "control.agent.resolved",
      occurredAt: 0,
      runId: "run-1",
      payload: { text: "x".repeat(McpServer.maximumHistoryBytes) }
    }
    const largeControl = Layer.effect(
      ControlService.Control,
      Effect.map(
        ControlService.Control,
        (service) => ControlService.make({ ...service, watch: () => Stream.make(oversized) })
      )
    ).pipe(Layer.provide(control))

    expect(await rpcCallWith(largeControl, "get_run_events", { runId: "run-1" }))
      .toMatchObject({ ok: false, error: { code: "RESOURCE_LIMIT" } })
  })

  it("answers the raw surface with the command to run", async () => {
    expect(await call(find("cli_ps"))).toMatchObject({ ok: true, data: { command: "smthrs ps" } })
  })

  it("builds both envelope shapes", () => {
    expect(McpServer.succeeded(1)).toEqual({ ok: true, data: 1 })
    expect(McpServer.failed("code", "why")).toEqual({ ok: false, error: { code: "code", message: "why" } })
  })
})

/**
 * The answers each tool gives when its arguments are good and the control
 * plane has something to say.
 *
 * The cases above pin the refusals: a missing argument, an undeclared member,
 * a status the schema does not admit. What none of them reach is the body each
 * tool runs once it is past them, which is the half an agent actually reads.
 */
describe("what each tool answers on the path through", () => {
  const demoFlow = {
    flowId: "demo/ship",
    description: "The fixture flow these cases plan and launch",
    deployClass: false,
    envelope: { capabilities: [], flows: [], budget: {} }
  } as const

  const projectControl = TestControl.layer({ now: () => 0, flows: [demoFlow] })

  const event = (sequence: number, kind: string, payload: unknown) => ({
    sequence,
    kind,
    runId: "run-1",
    occurredAt: sequence * 1000,
    payload
  })

  const history = [
    event(1, "control.run.started", null),
    event(2, "control.agent.cell-call-started", { flowName: "read", input: { path: "a.ts" } }),
    event(3, "control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: "contents of a" })
  ]

  /** A plane holding one running run with a fixed, finite history. */
  const runControl = (
    status = "running",
    events: ReadonlyArray<unknown> = history
  ) =>
    Layer.effect(
      ControlService.Control,
      Effect.map(ControlService.Control, (service) =>
        ControlService.make({
          ...service,
          list: (request) =>
            request._tag === "runs"
              ? Effect.succeed(
                {
                  _tag: "runs",
                  items: [{ runId: "run-1", flowId: "demo/ship", status, createdAt: 0, updatedAt: 0 }]
                } as never
              )
              : service.list(request),
          watch: () => Stream.fromIterable(events as never)
        }))
    ).pipe(Layer.provide(projectControl))

  it("plans, approves for the run, and launches a project flow", async () => {
    const result = await callWith(projectControl, find("run_workflow"), {
      flowId: "demo/ship",
      input: { target: "main" }
    }) as { readonly ok: true; readonly data: { readonly runId: string } }

    // One call does all three steps, because an agent that could plan without
    // approving would leave a plan nobody can launch.
    expect(result.ok).toBe(true)
    expect(result.data.runId).toBeTypeOf("string")
  })

  it("answers a watch with the run's status and the events past the cursor", async () => {
    const whole = await callWith(runControl(), find("watch_run"), { runId: "run-1" }) as {
      readonly data: { readonly status: string; readonly events: ReadonlyArray<unknown>; readonly sequence: number }
    }
    const tail = await callWith(runControl(), find("watch_run"), { runId: "run-1", afterSequence: 2 }) as {
      readonly data: { readonly events: ReadonlyArray<{ readonly sequence: number }>; readonly sequence: number }
    }

    expect(whole.data).toMatchObject({ status: "running", sequence: 3 })
    expect(whole.data.events).toHaveLength(3)
    // The cursor is exclusive, and the reported sequence is where the next
    // call should resume from rather than where this one started.
    expect(tail.data.events.map((one) => one.sequence)).toEqual([3])
    expect(tail.data.sequence).toBe(3)
  })

  it("reads the whole event history, the transcript, and one node's output", async () => {
    const control = runControl()

    const events = await callWith(control, find("get_run_events"), { runId: "run-1" }) as {
      readonly data: ReadonlyArray<unknown>
    }
    const transcript = await callWith(control, find("get_chat_transcript"), { runId: "run-1" }) as {
      readonly data: { readonly runId: string; readonly transcript: string }
    }
    const node = await callWith(control, find("get_node_detail"), { runId: "run-1", nodeId: "read#1" }) as {
      readonly data: { readonly nodeId: string; readonly value: unknown }
    }

    expect(events.data).toHaveLength(3)
    expect(transcript.data.runId).toBe("run-1")
    expect(transcript.data.transcript).toBeTypeOf("string")
    expect(node.data).toMatchObject({ nodeId: "read#1", value: "contents of a" })
  })

  it("explains a run with its status, digest, and the same card `smthrs status` prints", async () => {
    const explained = await callWith(runControl(), find("explain_run"), { runId: "run-1" }) as {
      readonly data: { readonly runId: string; readonly status: string; readonly card: string }
    }

    expect(explained.data).toMatchObject({ runId: "run-1", status: "running" })
    expect(explained.data.card).toContain("run-1")
  })

  it("lists a parked run with the payload that releases it, and an empty list when none is parked", async () => {
    const parked = await callWith(
      runControl("waiting-approval"),
      find("list_pending_approvals")
    ) as { readonly data: ReadonlyArray<{ readonly runId: string; readonly flowId: string }> }
    const none = await callWith(projectControl, find("list_pending_approvals")) as {
      readonly data: ReadonlyArray<unknown>
    }

    expect(parked.data).toHaveLength(1)
    expect(parked.data[0]).toMatchObject({ runId: "run-1", flowId: "demo/ship" })
    expect(none.data).toEqual([])
  })

  it("narrows the pending-approval listing to one run when the caller names it", async () => {
    const only = await callWith(runControl("waiting-approval"), find("list_pending_approvals"), {
      runId: "run-1"
    }) as { readonly data: ReadonlyArray<{ readonly runId: string }> }

    expect(only.data.map((entry) => entry.runId)).toEqual(["run-1"])
  })
})

describe("the mode flags read straight off argv", () => {
  it("selects the server on --mcp and on nothing else", () => {
    expect(McpServer.requested(["--mcp"])).toBe(true)
    expect(McpServer.requested(["ps", "--json"])).toBe(false)
  })

  it("reads the surface, the allowlist, and read-only from either flag spelling", () => {
    expect(McpServer.optionsFromArguments(["--mcp", "--surface", "raw", "--read-only"]))
      .toEqual({ surface: "raw", readOnly: true })
    expect(McpServer.optionsFromArguments(["--mcp", "--surface=both", "--allowed-tools=get_run, list_runs ,"]))
      .toEqual({ surface: "both", allowedTools: ["get_run", "list_runs"], readOnly: false })
  })

  it("falls back to the semantic surface for a value it does not know", () => {
    // An unreadable surface is not a reason to widen one: the default is the
    // narrowest of the three, which is what a client that sent nothing gets.
    expect(McpServer.optionsFromArguments(["--mcp", "--surface", "everything"]))
      .toEqual({ surface: "semantic", readOnly: false })
    expect(McpServer.optionsFromArguments([])).toEqual({ surface: "semantic", readOnly: false })
  })
})

describe("the JSON-RPC surface", () => {
  const session = McpServer.tools()
  const respond = (request: unknown) =>
    Effect.runPromise(
      McpServer.respond(request as never, session, "1.0.0-rc.0").pipe(Effect.provide(control)) as Effect.Effect<
        Record<string, unknown> | undefined
      >
    )

  it("answers the handshake with the protocol revision and the server name", async () => {
    const reply = await respond({ jsonrpc: "2.0", id: 1, method: "initialize" })

    expect(reply).toMatchObject({
      id: 1,
      result: { protocolVersion: McpServer.protocolVersion, serverInfo: { name: "smithers", version: "1.0.0-rc.0" } }
    })
  })

  it("answers ping and lists tools with their read-only annotation", async () => {
    expect(await respond({ jsonrpc: "2.0", id: 2, method: "ping" })).toMatchObject({ result: {} })
    const listed = await respond({ jsonrpc: "2.0", id: 3, method: "tools/list" }) as {
      readonly result: { readonly tools: ReadonlyArray<Record<string, unknown>> }
    }

    expect(listed.result.tools).toHaveLength(21)
    expect(listed.result.tools[0]).toMatchObject({ name: "list_workflows", annotations: { readOnlyHint: true } })
  })

  it("answers a call for a tool this session does not expose", async () => {
    const reply = await respond({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "invented" } }) as {
      readonly result: { readonly structuredContent: McpServer.Envelope }
    }

    expect(reply.result.structuredContent).toMatchObject({ ok: false, error: { code: "unknown_tool" } })
  })

  it("carries the envelope in both the text block and the structured content", async () => {
    const reply = await respond({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "ask_human", arguments: {} }
    }) as { readonly result: { readonly content: ReadonlyArray<{ readonly text: string }>; readonly isError: boolean } }

    expect(reply.result.isError).toBe(true)
    expect(JSON.parse(reply.result.content[0]!.text)).toMatchObject({ ok: false, error: { code: "unsupported" } })
  })

  it("answers an unknown method with a JSON-RPC error and ignores a notification", async () => {
    expect(await respond({ jsonrpc: "2.0", id: 6, method: "resources/list" }))
      .toMatchObject({ error: { code: -32601 } })
    expect(await respond({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined()
  })

  it("accepts the exact request-frame boundary and refuses the next byte", async () => {
    const request = (filler: string) => ({
      jsonrpc: "2.0",
      id: "bounded",
      method: "tools/call",
      params: { name: "list_runs", arguments: { unexpected: filler } }
    })
    const fixedBytes = Buffer.byteLength(JSON.stringify(request("")), "utf8")
    const exact = request("x".repeat(McpServer.maximumFrameBytes - fixedBytes))
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(McpServer.maximumFrameBytes)

    const accepted = await respond(exact) as {
      readonly result: { readonly structuredContent: McpServer.Envelope }
    }
    expect(accepted.result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" }
    })

    const refused = await respond(request(`${"x".repeat(McpServer.maximumFrameBytes - fixedBytes)}x`)) as {
      readonly result: { readonly structuredContent: McpServer.Envelope }
    }
    expect(refused.result.structuredContent).toEqual({
      ok: false,
      error: {
        code: "RESOURCE_LIMIT",
        message: `MCP request or response exceeds the ${McpServer.maximumFrameBytes}-byte frame limit`
      }
    })
  })

  it("replaces an oversized tool response before it reaches the wire", async () => {
    const huge: McpServer.Tool = {
      name: "huge",
      description: "bounded response fixture",
      readOnly: true,
      schema: Schema.Struct({}),
      inputSchema: { type: "object" },
      call: () => Effect.succeed(McpServer.succeeded("x".repeat(McpServer.maximumFrameBytes)))
    }
    const reply = await Effect.runPromise(
      McpServer.respond(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "huge", arguments: {} } } as never,
        [huge],
        "1.0.0-rc.0"
      ).pipe(Effect.provide(control))
    ) as { readonly result: { readonly structuredContent: McpServer.Envelope } }

    expect(reply.result.structuredContent).toMatchObject({ ok: false, error: { code: "RESOURCE_LIMIT" } })
    expect(Buffer.byteLength(JSON.stringify(reply), "utf8")).toBeLessThanOrEqual(McpServer.maximumFrameBytes)
  })

  it("bounds schema issue text for a large invalid argument", async () => {
    const reply = await respond({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "watch_run",
        arguments: { runId: "run-1", afterSequence: "x".repeat(32_000) }
      }
    }) as { readonly result: { readonly structuredContent: McpServer.Envelope } }
    const error = (reply.result.structuredContent as Extract<McpServer.Envelope, { readonly ok: false }>).error

    expect(error.code).toBe("INVALID_INPUT")
    expect([...error.message].length).toBeLessThanOrEqual(1024)
  })
})

describe("the in-process stdio loop", () => {
  it("answers complete frames after malformed input and ends when input closes", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let captured = ""
    output.setEncoding("utf8")
    output.on("data", (chunk: string) => {
      captured += chunk
    })

    const serving = Effect.runPromise(
      McpServer.serve({ version: "1.0.0-rc.0", input, output }).pipe(Effect.provide(control))
    )
    input.end(
      [
        JSON.stringify({ jsonrpc: "2.0", id: "initialize", method: "initialize" }),
        "this is not json",
        JSON.stringify({ jsonrpc: "2.0", id: "list", method: "tools/list" }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: "call",
          method: "tools/call",
          params: { name: "list_workflows", arguments: {} }
        })
      ].join("\n") + "\n"
    )

    await serving

    const frames = captured.trim().split("\n").map((line) =>
      JSON.parse(line) as {
        readonly id: string
        readonly result: Record<string, unknown>
      }
    )
    expect(frames).toHaveLength(3)
    const replies = new Map(frames.map((frame) => [frame.id, frame.result]))
    expect(replies.get("initialize")).toMatchObject({ protocolVersion: McpServer.protocolVersion })
    expect((replies.get("list") as { readonly tools: ReadonlyArray<{ readonly name: string }> }).tools
      .map((tool) => tool.name)).toEqual(McpServer.tools().map((tool) => tool.name))
    expect(replies.get("call")).toMatchObject({ structuredContent: { ok: true } })
  })

  it("discards a chunked oversized line and resumes at the next frame", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let captured = ""
    output.setEncoding("utf8")
    output.on("data", (chunk: string) => {
      captured += chunk
    })

    const serving = Effect.runPromise(
      McpServer.serve({ version: "1.0.0-rc.0", input, output }).pipe(Effect.provide(control))
    )
    input.write("x".repeat(Math.floor(McpServer.maximumFrameBytes / 2)))
    input.write("x".repeat(Math.ceil(McpServer.maximumFrameBytes / 2) + 1))
    input.end(`\n${JSON.stringify({ jsonrpc: "2.0", id: "after-limit", method: "ping" })}\n`)

    await serving

    const frames = captured.trim().split("\n").map((line) => JSON.parse(line))
    expect(frames).toHaveLength(2)
    expect(frames[0]).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message: `MCP request or response exceeds the ${McpServer.maximumFrameBytes}-byte frame limit`
      }
    })
    expect(frames[1]).toMatchObject({ id: "after-limit", result: {} })
  })
})

describe("a real stdio round trip", () => {
  it("connects, lists the tools, and calls one of each kind", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "smithers-mcp-"))
    staged.push(cwd)

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const client = yield* McpClient.connect({
            server: "smithers",
            command: process.execPath,
            args: ["--no-warnings", entry, "--mcp"],
            cwd,
            // The child boots the whole command tree through tsx before it can
            // answer, and the client's 10 s default is a boot budget this case
            // never meant to assert. Kept inside the case's own 60 s budget, so
            // a server that truly never answers still fails the run.
            //
            // The gap this leaves is deliberate and unclosed: a `--mcp` boot
            // that regressed past the shipped default would still pass here. A
            // wall-clock assertion is not the way to close it — a
            // coverage-instrumented tsx boot on a loaded host legitimately
            // exceeds 10 s while the shipped binary, which runs `dist/esm`,
            // does not. What this case can pin is the default a real client
            // arrives with, so a change to that number is never silent.
            handshakeTimeoutMs: 45_000
          })
          const supported = yield* client.callTool("list_workflows", {})
          const unsupported = yield* client.callTool("time_travel", {})
          return { tools: client.tools.map((tool) => tool.name), supported, unsupported }
        })
      ).pipe(Effect.provide(NodeServices.layer), Effect.orDie)
    )

    expect(McpClient.defaultHandshakeTimeoutMs).toBe(10_000)
    expect(result.tools).toHaveLength(21)
    expect(result.tools).toContain("list_workflows")
    expect(result.tools).toContain("ask_human")

    // One Control-backed tool answering over the real transport, and one
    // unsupported envelope pinned as the contract states it.
    const supported = JSON.parse(String(result.supported.content[0]?.text)) as McpServer.Envelope
    expect(supported).toMatchObject({ ok: true })
    expect(result.supported.isError).toBe(false)

    const unsupported = JSON.parse(String(result.unsupported.content[0]?.text)) as McpServer.Envelope
    expect(unsupported).toMatchObject({ ok: false, error: { code: "unsupported" } })
    expect(result.unsupported.isError).toBe(true)
  }, 60_000)
})
