import * as Cell from "@smthrs/harness/Cell"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Deferred, Effect, Fiber, Layer, Option, Queue, Ref, Sink, Stream } from "effect"
import type { Scope } from "effect"
import * as PlatformError from "effect/PlatformError"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import * as Rpc from "../src/internal/Rpc.ts"
import * as StdioTransport from "../src/internal/StdioTransport.ts"
import * as McpClient from "../src/McpClient.ts"
import * as McpFlows from "../src/McpFlows.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

type HandleOptions = Parameters<typeof makeHandle>[0]

/** A process handle with inert defaults; each case overrides only the seam it drives. */
const fakeProcess = (
  overrides: Pick<HandleOptions, "pid"> & Partial<HandleOptions>
): ChildProcessSpawner.ChildProcessSpawner["Service"] =>
  ChildProcessSpawner.makeNoop({
    spawn: (_command: ChildProcess.Command) =>
      Effect.succeed(makeHandle({
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.never,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
        ...overrides
      }))
  })

const provideSpawner = <A, E>(
  effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
) => Effect.provide(effect, Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(spawner))

/**
 * A fake MCP server: a stdin sink that parses each JSON-RPC line written to
 * it and, for every request it recognizes, pushes the scripted reply onto the
 * queue the fake's stdout stream drains. Unlike a static canned stream, this
 * reacts to what the client actually sends, so a reply is never available
 * before the client has registered the request it answers.
 */
const fakeServer = (
  respond: (request: Rpc.Outbound) => unknown,
  options: {
    readonly delimiter?: string | undefined
    readonly closeAfterReply?: boolean | undefined
  } = {}
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
          yield* Queue.offer(
            replies,
            encoder.encode(
              `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}${options.delimiter ?? "\n"}`
            )
          )
        }
      })
    )

    return fakeProcess({
      pid: ProcessId(1),
      stdin,
      stdout: options.closeAfterReply === true
        ? Stream.take(Stream.fromQueue(replies), 1)
        : Stream.fromQueue(replies)
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
  effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>,
  options?: {
    readonly delimiter?: string | undefined
    readonly closeAfterReply?: boolean | undefined
  }
): Promise<A> =>
  execute(Effect.scoped(Effect.gen(function*() {
    const spawner = yield* fakeServer(respond, options)
    return yield* provideSpawner(effect, spawner)
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

describe("StdioTransport limits and terminal state", () => {
  it.each([
    { requestTimeoutMs: 0 },
    { queueCapacity: 0 },
    { maxFrameBytes: 0 },
    { requestTimeoutMs: 1.5 }
  ])("rejects invalid transport limits: %o", async (limits) => {
    const error = await withFakeServer(
      respondToEcho,
      Effect.flip(StdioTransport.connect({ server: "limited", command: "mcp", args: [], ...limits }))
    )

    expect(error).toMatchObject({ code: "protocol_error", server: "limited" })
  })

  it("rejects an invalid per-request deadline before writing", async () => {
    const error = await withFakeServer(
      respondToEcho,
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({ server: "deadline", command: "mcp", args: [] })
        return yield* Effect.flip(transport.request("ping", {}, 0))
      })
    )

    expect(error).toMatchObject({ code: "protocol_error", server: "deadline" })
  })

  it.each([
    ["CRLF", "\r\n", false],
    ["an unterminated frame", "", true],
    ["an unterminated frame ending in CR", "\r", true]
  ])("accepts %s", async (_label, delimiter, closeAfterReply) => {
    const result = await withFakeServer(
      () => "pong",
      Effect.gen(function*() {
        const transport = yield* StdioTransport.connect({ server: "framing", command: "mcp", args: [] })
        return yield* transport.request("ping")
      }),
      { delimiter, closeAfterReply }
    )

    expect(result).toBe("pong")
  })

  it("bounds notifications when a server stops reading stdin", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const writerStarted = yield* Deferred.make<void>()
      const spawner = fakeProcess({
        pid: ProcessId(2),
        stdin: Sink.forEach((_chunk: Uint8Array) =>
          Deferred.succeed(writerStarted, undefined).pipe(Effect.andThen(Effect.never))
        )
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({
          server: "blocked-writer",
          command: "mcp",
          args: [],
          queueCapacity: 1,
          requestTimeoutMs: 25
        }),
        spawner
      )

      yield* transport.notify("first")
      yield* Deferred.await(writerStarted)
      yield* transport.notify("second")
      return yield* Effect.flip(transport.notify("third"))
    })))

    expect(error).toMatchObject({ code: "timeout", server: "blocked-writer" })
  })

  it("turns an exit-status failure into one terminal error for later traffic", async () => {
    const errors = await execute(Effect.scoped(Effect.gen(function*() {
      const spawner = fakeProcess({
        pid: ProcessId(3),
        exitCode: Effect.fail(PlatformError.systemError({
          _tag: "Unknown",
          module: "ChildProcess",
          method: "exitCode",
          description: "fixture failure"
        })),
        isRunning: Effect.succeed(false)
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({ server: "bad-exit", command: "mcp", args: [] }),
        spawner
      )
      yield* Effect.sleep("10 millis")
      const request = yield* Effect.flip(transport.request("later"))
      const notification = yield* Effect.flip(transport.notify("later"))
      yield* Effect.sleep("10 millis")
      return { request, notification }
    })))

    expect(errors.request).toMatchObject({
      code: "connection_closed",
      message: expect.stringContaining("process exited"),
      server: "bad-exit"
    })
    expect(errors.notification).toBe(errors.request)
  })

  it("ignores a late reply after the process exit has closed the state", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const frame = new TextEncoder().encode("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"late\"}\n")
      const spawner = fakeProcess({
        pid: ProcessId(4),
        exitCode: Effect.succeed(ExitCode(0)),
        isRunning: Effect.succeed(false),
        stdout: Stream.fromEffect(Effect.as(Effect.sleep("10 millis"), frame))
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({ server: "late-reply", command: "mcp", args: [] }),
        spawner
      )
      yield* Effect.sleep("25 millis")
      return yield* Effect.flip(transport.notify("later"))
    })))

    expect(error).toMatchObject({ code: "connection_closed", server: "late-reply" })
  })

  it("normalizes a host failure while reading stdout", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const failure = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "stdout",
        description: "fixture failure"
      })
      const spawner = fakeProcess({
        pid: ProcessId(5),
        stdout: Stream.fail(failure)
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({ server: "bad-stdout", command: "mcp", args: [] }),
        spawner
      )
      yield* Effect.sleep("10 millis")
      return yield* Effect.flip(transport.request("later"))
    })))

    expect(error).toMatchObject({
      code: "connection_closed",
      message: expect.stringContaining("stdout failed"),
      server: "bad-stdout"
    })
  })

  it("wakes a blocked enqueue when the process exits", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const writerStarted = yield* Deferred.make<void>()
      const exit = yield* Deferred.make<ExitCode>()
      const spawner = fakeProcess({
        pid: ProcessId(6),
        exitCode: Deferred.await(exit),
        stdin: Sink.forEach((_chunk: Uint8Array) =>
          Deferred.succeed(writerStarted, undefined).pipe(Effect.andThen(Effect.never))
        )
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({
          server: "blocked-enqueue",
          command: "mcp",
          args: [],
          queueCapacity: 1,
          requestTimeoutMs: 1_000
        }),
        spawner
      )
      yield* transport.notify("first")
      yield* Deferred.await(writerStarted)
      yield* transport.notify("second")
      const blocked = yield* Effect.forkChild(transport.notify("third"), { startImmediately: true })
      yield* Effect.sleep("10 millis")
      yield* Deferred.succeed(exit, ExitCode(0))
      return yield* Effect.flip(Fiber.join(blocked))
    })))

    expect(error).toMatchObject({
      code: "connection_closed",
      message: expect.stringContaining("outbound queue closed"),
      server: "blocked-enqueue"
    })
  })

  it("fails every request pending at one terminal transition", async () => {
    const errors = await execute(Effect.scoped(Effect.gen(function*() {
      const exit = yield* Deferred.make<ExitCode>()
      const writes = yield* Ref.make(0)
      const allWritten = yield* Deferred.make<void>()
      const spawner = fakeProcess({
        pid: ProcessId(7),
        exitCode: Deferred.await(exit),
        stdin: Sink.forEach((_chunk: Uint8Array) =>
          Ref.updateAndGet(writes, (count) => count + 1).pipe(
            Effect.flatMap((count) => count === 3 ? Deferred.succeed(allWritten, undefined) : Effect.void)
          )
        )
      })
      const transport = yield* provideSpawner(
        StdioTransport.connect({ server: "pending", command: "mcp", args: [] }),
        spawner
      )
      const pending = yield* Effect.forkChild(
        Effect.all(
          ["one", "two", "three"].map((method) => Effect.flip(transport.request(method))),
          { concurrency: "unbounded" }
        ),
        { startImmediately: true }
      )
      yield* Deferred.await(allWritten)
      yield* Deferred.succeed(exit, ExitCode(0))
      return yield* Fiber.join(pending)
    })))

    expect(errors).toHaveLength(3)
    expect(errors.every((error) => error === errors[0])).toBe(true)
    expect(errors[0]).toMatchObject({ code: "connection_closed", server: "pending" })
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
    expect(bindings[0]!.descriptor.capabilities).toEqual(McpFlows.capabilities)
  })

  it("runs a tool call through the produced binding", async () => {
    const result = await withFakeServer(
      respondToEcho,
      Effect.flatMap(McpClient.connect({ server: "echo", command: "echo-mcp", args: [] }), (client) => {
        const [binding] = McpFlows.mcp(client).bindings().pipe(Effect.runSync)
        const call = new Cell.Call({
          flowName: "mcp/echo/add",
          input: { a: 2, b: 3 },
          capabilities: McpFlows.capabilities,
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
