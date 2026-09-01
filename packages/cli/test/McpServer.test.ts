/**
 * The `smithers --mcp` tool surface, and one real stdio round trip.
 *
 * The round trip runs `@smthrs/mcp`'s own client against a spawned
 * `smithers --mcp`, so the framing, the handshake, and the envelope are proven
 * by the code that consumes them rather than by a reimplementation.
 */
import { NodeServices } from "@effect/platform-node"
import { Control as ControlService, ControlError, ControlRuntime } from "@smthrs/control"
import * as TestControl from "@smthrs/control/test/TestControl"
import * as McpClient from "@smthrs/mcp/McpClient"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

const call = (tool: McpServer.Tool, args: Record<string, unknown> = {}) =>
  Effect.runPromise(tool.call(args).pipe(Effect.provide(control)) as Effect.Effect<McpServer.Envelope>)

const callWith = (
  provided: Layer.Layer<ControlService.Control>,
  tool: McpServer.Tool,
  args: Record<string, unknown> = {}
) => Effect.runPromise(tool.call(args).pipe(Effect.provide(provided)) as Effect.Effect<McpServer.Envelope>)

const rpcCallWith = async (
  provided: Layer.Layer<ControlService.Control>,
  name: string,
  args: Record<string, unknown> = {}
): Promise<McpServer.Envelope> => {
  const reply = await Effect.runPromise(
    McpServer.respond(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } } as never,
      McpServer.tools(),
      "1.0.0-rc.0"
    ).pipe(Effect.provide(provided)) as Effect.Effect<Record<string, unknown>>
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
    expect(raw.find((tool) => tool.name === "cli_ps")?.description).toContain("smithers ps")
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
    const result = await call(find("list_workflows")) as { readonly ok: true; readonly data: ReadonlyArray<{
      readonly flowId: string
    }> }

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
    for (const status of [
      "accepted",
      "running",
      "parked",
      "waiting-approval",
      "cancelled",
      "completed",
      "failed"
    ]) expect(message).toContain(status)

    expect(await rpcCall("list_runs", { status: "running" })).toMatchObject({ ok: true })
  })

  it.each([-1, 1.5])("refuses the watch cursor %s", async (afterSequence) => {
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

  it("redacts a credential from a tagged failure message", async () => {
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
    expect(error.message).toContain("[REDACTED_TOKEN]")
    expect(error.message).not.toContain(credential)
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

  it("answers the raw surface with the command to run", async () => {
    expect(await call(find("cli_ps"))).toMatchObject({ ok: true, data: { command: "smithers ps" } })
  })

  it("builds both envelope shapes", () => {
    expect(McpServer.succeeded(1)).toEqual({ ok: true, data: 1 })
    expect(McpServer.failed("code", "why")).toEqual({ ok: false, error: { code: "code", message: "why" } })
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
            cwd
          })
          const supported = yield* client.callTool("list_workflows", {})
          const unsupported = yield* client.callTool("time_travel", {})
          return { tools: client.tools.map((tool) => tool.name), supported, unsupported }
        })
      ).pipe(Effect.provide(NodeServices.layer), Effect.orDie)
    )

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
