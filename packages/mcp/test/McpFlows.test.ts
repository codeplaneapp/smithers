import * as Cell from "@smthrs/harness/Cell"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Effect, Layer, Option, Queue, Ref, Sink, Stream } from "effect"
import type { Scope } from "effect"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as Rpc from "../src/internal/Rpc.ts"
import * as McpClient from "../src/McpClient.ts"
import * as McpFlows from "../src/McpFlows.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

/**
 * A fake MCP server: a stdin sink that parses each JSON-RPC line written to
 * it and, for every request it recognizes, pushes the scripted reply onto the
 * queue the fake's stdout stream drains. Unlike a static canned stream, this
 * reacts to what the client actually sends, so a reply is never available
 * before the client has registered the request it answers.
 */
const fakeServer = (
  respond: (request: Rpc.Outbound) => unknown
): Effect.Effect<ChildProcessSpawner.ChildProcessSpawner["Service"]> =>
  Effect.gen(function*() {
    const replies = yield* Queue.unbounded<Uint8Array>()
    const buffer = yield* Ref.make("")
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()

    const stdin = Sink.forEach((chunk: Uint8Array) =>
      Effect.gen(function*() {
        const combined = yield* Ref.updateAndGet(buffer, (existing) => existing + decoder.decode(chunk))
        const lines = combined.split("\n")
        yield* Ref.set(buffer, lines.pop() ?? "")
        for (const line of lines) {
          const request = Rpc.parse(line)
          if (request === undefined || request.id === undefined) continue
          const result = respond(request as unknown as Rpc.Outbound)
          if (result === undefined) continue
          yield* Queue.offer(replies, encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`))
        }
      })
    )

    return ChildProcessSpawner.makeNoop({
      spawn: (_command: ChildProcess.Command) =>
        Effect.succeed(makeHandle({
          pid: ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin,
          stdout: Stream.fromQueue(replies),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        }))
    })
  })

const TOOLS = [
  { name: "add", description: "Adds two numbers", inputSchema: { type: "object", properties: { a: {}, b: {} } } }
]

const respondToEcho = (request: Rpc.Outbound): unknown => {
  if (request.method === "initialize") return { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} }
  if (request.method === "tools/list") return { tools: TOOLS }
  if (request.method === "tools/call") {
    const params = request.params as {
      readonly name: string
      readonly arguments: { readonly a: number; readonly b: number }
    }
    return { content: [{ type: "text", text: String(params.arguments.a + params.arguments.b) }], isError: false }
  }
  return undefined
}

const withFakeServer = <A, E>(
  respond: (request: Rpc.Outbound) => unknown,
  effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>
): Promise<A> =>
  execute(Effect.scoped(Effect.gen(function*() {
    const spawner = yield* fakeServer(respond)
    return yield* Effect.provide(effect, Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner))
  })))

describe("McpClient.connect", () => {
  it("completes the handshake and fetches the tool catalog", async () => {
    const client = await withFakeServer(
      respondToEcho,
      McpClient.connect({ server: "echo", command: "echo-mcp", args: [] })
    )
    expect(client.server).toBe("echo")
    expect(client.tools).toEqual([{ name: "add", description: "Adds two numbers", inputSchema: TOOLS[0]!.inputSchema }])
  })

  it("calls a remote tool and decodes its result", async () => {
    const result = await withFakeServer(
      respondToEcho,
      Effect.flatMap(
        McpClient.connect({ server: "echo", command: "echo-mcp", args: [] }),
        (client) => client.callTool("add", { a: 2, b: 3 })
      )
    )
    expect(result).toEqual({ content: [{ type: "text", text: "5" }], isError: false })
  })

  it("fails with invalid_response when tools/list is malformed", async () => {
    const exit = await execute(Effect.scoped(Effect.gen(function*() {
      const spawner = yield* fakeServer((request) => request.method === "initialize" ? {} : { notTools: [] })
      return yield* Effect.provide(
        Effect.exit(McpClient.connect({ server: "broken", command: "broken-mcp", args: [] })),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner)
      )
    })))
    expect(exit._tag).toBe("Failure")
  })
})

describe("McpFlows.mcp", () => {
  it("projects one flow per tool, disclosing the server's own input schema", async () => {
    const client = await withFakeServer(
      respondToEcho,
      McpClient.connect({ server: "echo", command: "echo-mcp", args: [] })
    )
    const source = McpFlows.mcp(client)
    const bindings = await execute(source.bindings())
    expect(bindings).toHaveLength(1)
    expect(bindings[0]!.descriptor.name).toBe("mcp/echo/add")
    expect(bindings[0]!.descriptor.capabilities).toEqual(["*"])
  })

  it("runs a tool call through the produced binding", async () => {
    const result = await withFakeServer(
      respondToEcho,
      Effect.flatMap(McpClient.connect({ server: "echo", command: "echo-mcp", args: [] }), (client) => {
        const [binding] = McpFlows.mcp(client).bindings().pipe(Effect.runSync)
        const call = new Cell.Call({
          flowName: "mcp/echo/add",
          input: { a: 2, b: 3 },
          capabilities: ["*"],
          effects: binding!.descriptor.effects,
          placement: Option.none(),
          identity: new Cell.CallIdentity({
            session: "test",
            frame: 0,
            cell: "test",
            ordinal: 0,
            declaration: Cell.declarationDigest(binding!.descriptor),
            layers: []
          })
        })
        return binding!.run(call)
      })
    )
    expect(result.outcome).toBe("success")
    expect(result.value).toEqual({ content: [{ type: "text", text: "5" }], isError: false })
  })

  it("uses conservative metadata defaults for an incomplete tool description", async () => {
    const source = McpFlows.mcp({
      server: "partial",
      tools: [{ name: "run", description: undefined, inputSchema: undefined }],
      callTool: () => Effect.succeed({ content: [], isError: false })
    })
    const [binding] = await execute(source.bindings())
    expect(binding!.descriptor.description).toBe("MCP tool \"run\" on server \"partial\"")
    expect(binding!.descriptor.input).toMatchObject({ document: { type: "object" } })
  })
})
