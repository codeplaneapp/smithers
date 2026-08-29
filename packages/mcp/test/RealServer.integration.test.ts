/**
 * Integration coverage against a real, separately-processed MCP server.
 *
 * The fixture is a small MCP server run through `node -e`. It keeps the OS
 * process boundary and real stdio timing while remaining deterministic and
 * offline, and exposes modes for protocol and lifecycle failures that an
 * in-memory process handle cannot faithfully reproduce.
 *
 * @since 0.1.0
 */
import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import * as McpClient from "../src/McpClient.ts"
import * as McpFlows from "../src/McpFlows.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

const SERVER = String.raw`
const fs = require("node:fs")
const readline = require("node:readline")
const mode = process.argv[1] || "normal"
const closeMarker = process.argv[2]

if (closeMarker) {
  process.on("SIGTERM", () => {
    fs.writeFileSync(closeMarker, "closed")
    process.exit(0)
  })
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n")
const succeed = (request, result) => send({ jsonrpc: "2.0", id: request.id, result })

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line)
  if (request.method === "initialize") {
    if (mode === "malformed-frames") {
      process.stdout.write("\nnot json\n42\n")
      send({ jsonrpc: "1.0", id: request.id, result: {} })
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
      send({ jsonrpc: "2.0", id: 999, result: {} })
    }
    succeed(request, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture" } })
    return
  }

  if (request.method === "tools/list") {
    if (mode === "list-not-array") {
      succeed(request, { notTools: [] })
      return
    }
    if (mode === "list-no-name") {
      succeed(request, { tools: [{}] })
      return
    }
    if (mode === "list-empty-name") {
      succeed(request, { tools: [{ name: "" }] })
      return
    }
    succeed(request, {
      tools: [
        {
          name: "add",
          description: "Adds two numbers",
          inputSchema: { type: "object", properties: { a: {}, b: {} } }
        },
        { name: "error", description: 42 }
      ]
    })
    if (mode === "close-stdin") {
      setImmediate(() => fs.closeSync(0))
      setInterval(() => {}, 1000)
    }
    return
  }

  if (request.method === "tools/call") {
    if (mode === "exit-mid-call") process.exit(0)
    if (mode === "hang") return
    if (request.params.name === "rpc-error") {
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "remote exploded" } })
      return
    }
    if (request.params.name === "error") {
      succeed(request, { content: "malformed content", isError: true })
      return
    }
    succeed(request, {
      content: [{ type: "text", text: String(request.params.arguments.a + request.params.arguments.b) }],
      isError: false
    })
  }
})
`

const connectNode = (mode = "normal", extraArgs: ReadonlyArray<string> = []) =>
  Effect.provide(
    McpClient.connect({
      server: mode,
      command: process.execPath,
      args: ["-e", SERVER, mode, ...extraArgs]
    }),
    NodeServices.layer
  )

describe("McpClient against a real MCP server", () => {
  it("completes the handshake, ignores unrelated frames, and lists tools", async () => {
    const client = await execute(Effect.scoped(connectNode("malformed-frames")))
    expect(client.tools).toEqual([
      {
        name: "add",
        description: "Adds two numbers",
        inputSchema: { type: "object", properties: { a: {}, b: {} } }
      },
      { name: "error", description: undefined, inputSchema: { type: "object" } }
    ])
  })

  it("calls tools and preserves ordinary MCP isError outcomes", async () => {
    const results = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode()
      const added = yield* client.callTool("add", { a: 2, b: 3 })
      const failed = yield* client.callTool("error", {})
      return { added, failed }
    })))
    expect(results.added).toEqual({ content: [{ type: "text", text: "5" }], isError: false })
    expect(results.failed).toEqual({ content: [], isError: true })
  })

  it("maps a JSON-RPC error response to tool_failed", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode()
      return yield* Effect.flip(client.callTool("rpc-error", {}))
    })))
    expect(error).toMatchObject({ code: "tool_failed", message: "remote exploded", server: "normal" })
  })

  it.each([
    ["list-not-array", "tools/list did not return a tools array"],
    ["list-no-name", "tools/list returned a tool with no name"],
    ["list-empty-name", "tools/list returned a tool with no name"]
  ])("rejects a malformed catalog in %s mode", async (mode, message) => {
    const error = await execute(Effect.scoped(Effect.flip(connectNode(mode))))
    expect(error).toMatchObject({ code: "invalid_response", message, server: mode })
  })

  it("reports spawn failures", async () => {
    const error = await execute(Effect.scoped(Effect.flip(Effect.provide(
      McpClient.connect({ server: "missing", command: "flows-command-that-does-not-exist", args: [] }),
      NodeServices.layer
    ))))
    expect(error).toMatchObject({ code: "spawn_failed", server: "missing" })
  })

  it("fails a pending call when the server exits", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("exit-mid-call")
      return yield* Effect.flip(client.callTool("add", { a: 1, b: 2 }).pipe(Effect.timeout("2 seconds")))
    })))
    expect(error).toMatchObject({ code: "connection_closed", server: "exit-mid-call" })
  })

  it("fails a pending call when the server closes stdin", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("close-stdin")
      yield* Effect.sleep("100 millis")
      return yield* Effect.flip(client.callTool("add", { a: 1, b: 2 }).pipe(Effect.timeout("2 seconds")))
    })))
    expect(error).toMatchObject({ code: "connection_closed", server: "close-stdin" })
  })

  it("allows callers to bound an unresponsive request", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("hang")
      return yield* Effect.flip(client.callTool("add", {}).pipe(Effect.timeout("100 millis")))
    })))
    expect(error._tag).toBe("TimeoutError")
  })

  it("tears the child process down when its scope closes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "flows-mcp-scope-"))
    const marker = join(directory, "closed")
    try {
      await execute(Effect.scoped(Effect.asVoid(connectNode("normal", [marker]))))
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 2_000 })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("connects and projects tools through McpFlows.connected", async () => {
    const source = await execute(Effect.scoped(Effect.provide(
      McpFlows.connected({
        server: "connected",
        command: process.execPath,
        args: ["-e", SERVER, "normal"]
      }),
      NodeServices.layer
    )))
    const bindings = await execute(source.bindings())
    expect(bindings.map((binding) => binding.descriptor.name)).toEqual([
      "mcp/connected/add",
      "mcp/connected/error"
    ])
  })
})
