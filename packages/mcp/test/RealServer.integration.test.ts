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
import { Effect, Schema } from "effect"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import * as StdioTransport from "../src/internal/StdioTransport.ts"
import * as McpClient from "../src/McpClient.ts"
import * as McpFlows from "../src/McpFlows.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

const SERVER = String.raw`
const fs = require("node:fs")
const readline = require("node:readline")
const mode = process.argv[1] || "normal"
const closeMarker = process.argv[2]

if (closeMarker && mode !== "capture-cancellation") {
  process.on("SIGTERM", () => {
    fs.writeFileSync(closeMarker, "closed")
    process.exit(0)
  })
}

const startupDiagnostic = mode === "stderr-exit"
  ? { text: "distinctive startup diagnostic\n", code: 17 }
  : mode === "stderr-tail-exit"
  ? { text: "DROP-".repeat(400) + "KEEP-THIS-TAIL-1234567890\n", code: 18 }
  : undefined
if (startupDiagnostic) {
  process.stderr.write(startupDiagnostic.text, () => process.exit(startupDiagnostic.code))
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n")
const replyId = (request) => mode === "string-reply-id" ? String(request.id) : request.id
const succeed = (request, result) => send({ jsonrpc: "2.0", id: replyId(request), result })
const fail = (request, code, message, data) => {
  const error = { code, message }
  if (data !== undefined) error.data = data
  send({ jsonrpc: "2.0", id: replyId(request), error })
}

const addTool = {
  name: "add",
  description: "Adds two numbers",
  inputSchema: { type: "object", properties: { a: {}, b: {} } }
}
if (["structured-valid", "structured-invalid-type", "structured-missing-required", "structured-only"].includes(mode)) {
  addTool.outputSchema = {
    type: "object",
    properties: { answer: { type: "number" } },
    required: ["answer"]
  }
}
if (mode === "structured-enum-invalid") {
  addTool.outputSchema = {
    type: "object",
    properties: { answer: { enum: [5, 6] } },
    required: ["answer"]
  }
}
if (mode === "structured-array-invalid") {
  addTool.outputSchema = {
    type: "object",
    properties: { values: { type: "array", items: { type: "number" } } },
    required: ["values"]
  }
}
if (mode === "structured-unsupported-keyword") {
  addTool.outputSchema = {
    type: "object",
    properties: { answer: { type: "string", minLength: 10 } },
    required: ["answer"]
  }
}
const errorTool = {
  name: "error",
  description: 42,
  inputSchema: { type: "object" }
}
const namedTool = (name) => ({ name, inputSchema: { type: "object" } })

const reader = startupDiagnostic === undefined ? readline.createInterface({ input: process.stdin }) : undefined
reader?.on("line", (line) => {
  const request = JSON.parse(line)
  if (request.method === "notifications/cancelled") {
    if (mode === "capture-cancellation" && closeMarker) {
      fs.appendFileSync(closeMarker, JSON.stringify(request) + "\n")
    }
    return
  }
  if (request.method === "initialize") {
    if (mode === "hang-handshake") return
    if (mode === "oversized-frame") {
      process.stdout.write("x".repeat(1024) + "\n")
      return
    }
    if (mode === "malformed-frames") {
      process.stdout.write("\nnot json\n42\n")
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
      send({ jsonrpc: "2.0", id: 999, result: {} })
    }
    if (mode === "wrong-jsonrpc-version") {
      send({ jsonrpc: "1.0", id: request.id, result: {} })
      return
    }
    if (mode === "reply-without-id") {
      send({ jsonrpc: "2.0", result: {} })
      return
    }
    if (mode === "malformed-initialize-result") {
      succeed(request, null)
      return
    }
    const protocolVersion = mode === "wrong-protocol-version"
      ? "1999-01-01"
      : mode === "older-protocol-version"
      ? "2024-11-05"
      : mode === "malformed-protocol-version"
      ? 42
      : "2025-06-18"
    const capabilities = mode === "no-tools-capability"
      ? {}
      : mode === "malformed-capabilities"
      ? null
      : { tools: {} }
    succeed(request, { protocolVersion, capabilities, serverInfo: { name: "fixture" } })
    if (mode === "stop-reading-after-initialize") {
      reader.pause()
      process.stdin.pause()
      setInterval(() => {}, 1000)
      setTimeout(() => {
        reader.resume()
        process.stdin.resume()
      }, 250)
    }
    return
  }

  if (request.method === "tools/list") {
    if (mode === "list-rpc-error") {
      fail(request, -32_601, "catalog unavailable")
      return
    }
    if (mode === "malformed-reply") {
      send({ jsonrpc: "2.0", id: request.id, error: null })
      return
    }
    if (mode === "list-not-array") {
      succeed(request, { notTools: [] })
      return
    }
    if (mode === "list-result-not-object") {
      succeed(request, null)
      return
    }
    if (mode === "list-no-name") {
      succeed(request, { tools: [{}] })
      return
    }
    if (mode === "list-empty-name") {
      succeed(request, { tools: [{ name: "", inputSchema: { type: "object" } }] })
      return
    }
    if (mode === "list-null-entry") {
      succeed(request, { tools: [addTool, null] })
      return
    }
    if (mode === "list-number-entry") {
      succeed(request, { tools: [addTool, 42] })
      return
    }
    if (mode === "list-array-entry") {
      succeed(request, { tools: [addTool, []] })
      return
    }
    if (mode === "list-duplicate-names") {
      succeed(request, { tools: [addTool, namedTool("add")] })
      return
    }
    if (mode === "list-two-pages") {
      succeed(request, request.params && request.params.cursor === "page-2"
        ? { tools: [errorTool] }
        : { tools: [addTool], nextCursor: "page-2" })
      return
    }
    if (mode === "list-three-pages") {
      const cursor = request.params && request.params.cursor
      succeed(request, cursor === "page-3"
        ? { tools: [namedTool("third")] }
        : cursor === "page-2"
        ? { tools: [errorTool], nextCursor: "page-3" }
        : { tools: [addTool], nextCursor: "page-2" })
      return
    }
    if (mode === "list-empty-middle-page") {
      const cursor = request.params && request.params.cursor
      succeed(request, cursor === "page-3"
        ? { tools: [errorTool] }
        : cursor === "page-2"
        ? { tools: [], nextCursor: "page-3" }
        : { tools: [addTool], nextCursor: "page-2" })
      return
    }
    if (mode === "list-repeated-cursor") {
      succeed(request, request.params && request.params.cursor === "again"
        ? { tools: [], nextCursor: "again" }
        : { tools: [addTool], nextCursor: "again" })
      return
    }
    if (mode === "list-bad-cursor") {
      succeed(request, { tools: [addTool], nextCursor: 42 })
      return
    }
    if (mode === "list-empty-cursor") {
      succeed(request, { tools: [addTool], nextCursor: "" })
      return
    }
    if (mode === "list-duplicate-across-pages") {
      succeed(request, request.params && request.params.cursor === "page-2"
        ? { tools: [namedTool("add")] }
        : { tools: [addTool], nextCursor: "page-2" })
      return
    }
    if (mode === "list-unbounded-pages") {
      const cursor = request.params && request.params.cursor
      const page = cursor === undefined ? 1 : Number(cursor.slice(5))
      succeed(request, { tools: [], nextCursor: "page-" + (page + 1) })
      return
    }
    succeed(request, {
      tools: [addTool, errorTool]
    })
    if (mode === "exit-after-list") setImmediate(() => process.exit(0))
    if (mode === "close-stdin") {
      setImmediate(() => fs.closeSync(0))
      setInterval(() => {}, 1000)
    }
    return
  }

  if (request.method === "tools/call") {
    if (mode === "exit-mid-call") process.exit(0)
    if (mode === "hang" || mode === "capture-cancellation") return
    if (mode === "call-rpc-error") {
      fail(request, -32_000, "remote exploded")
      return
    }
    if (mode === "call-invalid-params-unknown-tool") {
      fail(request, -32_602, "Unknown tool: add")
      return
    }
    if (mode === "call-invalid-params") {
      fail(request, -32_602, "Tool arguments are invalid")
      return
    }
    if (mode === "call-method-not-found-unknown-tool") {
      fail(request, -32_601, "Tool not found: add")
      return
    }
    if (mode === "call-rpc-error-string-data") {
      fail(request, -32_000, "remote exploded", "context")
      return
    }
    if (mode === "call-rpc-error-number-data") {
      fail(request, -32_000, "remote exploded", 7)
      return
    }
    if (mode === "call-rpc-error-boolean-data") {
      fail(request, -32_000, "remote exploded", true)
      return
    }
    if (mode === "call-rpc-error-long-data") {
      fail(request, -32_000, "remote exploded", "x".repeat(121))
      return
    }
    if (mode === "call-rpc-error-object-data") {
      fail(request, -32_000, "remote exploded", { secret: "hidden" })
      return
    }
    if (mode === "call-rpc-error-array-data") {
      fail(request, -32_000, "remote exploded", ["hidden"])
      return
    }
    if (mode === "echo-env") {
      succeed(request, {
        content: [{
          type: "environment",
          token: process.env.MCP_FIXTURE_TOKEN,
          hasPath: typeof process.env.PATH === "string" && process.env.PATH.length > 0,
          cwd: process.cwd()
        }],
        isError: false
      })
      return
    }
    if (mode === "call-result-not-object") {
      succeed(request, null)
      return
    }
    if (mode === "call-content-not-array") {
      succeed(request, { content: "malformed" })
      return
    }
    if (mode === "call-content-bad-entry") {
      succeed(request, { content: [{ type: "text" }, null] })
      return
    }
    if (mode === "call-content-string-entry") {
      succeed(request, { content: ["text"] })
      return
    }
    if (mode === "call-content-number-entry") {
      succeed(request, { content: [42] })
      return
    }
    if (mode === "call-content-array-entry") {
      succeed(request, { content: [[1]] })
      return
    }
    if (mode === "call-is-error-not-boolean") {
      succeed(request, { content: [], isError: "yes" })
      return
    }
    if (mode === "call-structured-content-not-object") {
      succeed(request, { content: [], structuredContent: [] })
      return
    }
    if (mode === "call-structured-content") {
      succeed(request, {
        content: [{ type: "text", text: "5" }],
        structuredContent: { sum: 5 },
        isError: false
      })
      return
    }
    if (mode === "structured-valid") {
      succeed(request, {
        content: [{ type: "text", text: "5" }],
        structuredContent: { answer: 5 },
        isError: false
      })
      return
    }
    if (mode === "structured-invalid-type") {
      succeed(request, { content: [], structuredContent: { answer: "five" }, isError: false })
      return
    }
    if (mode === "structured-missing-required") {
      succeed(request, { content: [], structuredContent: {}, isError: false })
      return
    }
    if (mode === "structured-enum-invalid") {
      succeed(request, { content: [], structuredContent: { answer: 7 }, isError: false })
      return
    }
    if (mode === "structured-array-invalid") {
      succeed(request, { content: [], structuredContent: { values: [1, "two"] }, isError: false })
      return
    }
    if (mode === "structured-unsupported-keyword") {
      succeed(request, { content: [], structuredContent: { answer: "x" }, isError: false })
      return
    }
    if (mode === "structured-no-output-schema") {
      succeed(request, { content: [], structuredContent: { arbitrary: ["accepted"] }, isError: false })
      return
    }
    if (mode === "structured-only") {
      succeed(request, { structuredContent: { answer: 5 }, isError: false })
      return
    }
    if (mode === "structured-neither") {
      succeed(request, { isError: false })
      return
    }
    if (request.params.name === "error") {
      succeed(request, { content: [], isError: true })
      return
    }
    succeed(request, {
      content: [{ type: "text", text: String(request.params.arguments.a + request.params.arguments.b) }],
      isError: false
    })
  }
})
`

const connectNode = (
  mode = "normal",
  extraArgs: ReadonlyArray<string> = [],
  overrides: Partial<McpClient.ConnectOptions> = {}
) =>
  Effect.provide(
    McpClient.connect({
      server: mode,
      command: process.execPath,
      args: ["-e", SERVER, mode, ...extraArgs],
      ...overrides
    }),
    NodeServices.layer
  )

const connectTransportNode = (
  mode: string,
  overrides: Partial<StdioTransport.ConnectOptions> = {}
) =>
  Effect.provide(
    StdioTransport.connect({
      server: mode,
      command: process.execPath,
      args: ["-e", SERVER, mode],
      ...overrides
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
        inputSchema: { type: "object", properties: { a: {}, b: {} } },
        outputSchema: undefined
      },
      {
        name: "error",
        description: undefined,
        inputSchema: { type: "object" },
        outputSchema: undefined
      }
    ])
  })

  it("closes when a JSON-RPC-tagged reply carries the wrong version", async () => {
    const error = await execute(Effect.scoped(Effect.flip(connectNode("wrong-jsonrpc-version"))))
    expect(error).toMatchObject({
      code: "protocol_error",
      server: "wrong-jsonrpc-version",
      message:
        "MCP server \"wrong-jsonrpc-version\" sent a malformed JSON-RPC reply: a JSON-RPC message must carry jsonrpc \"2.0\""
    })
  })

  it("closes when a JSON-RPC reply carries no id", async () => {
    const error = await execute(Effect.scoped(Effect.flip(connectNode("reply-without-id"))))
    expect(error).toMatchObject({
      code: "protocol_error",
      server: "reply-without-id",
      message: "MCP server \"reply-without-id\" sent a malformed JSON-RPC reply: a reply carried no id"
    })
  })

  it("calls tools and preserves ordinary MCP isError outcomes", async () => {
    const results = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode()
      const added = yield* client.callTool("add", { a: 2, b: 3 })
      const failed = yield* client.callTool("error", {})
      return { added, failed }
    })))
    expect(results.added).toEqual({
      content: [{ type: "text", text: "5" }],
      isError: false,
      structuredContent: undefined
    })
    expect(results.failed).toEqual({ content: [], isError: true, structuredContent: undefined })
  })

  it("maps a JSON-RPC error response to tool_failed", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("call-rpc-error")
      return yield* Effect.flip(client.callTool("add", {}))
    })))
    expect(error).toMatchObject({
      code: "tool_failed",
      message: "MCP server \"call-rpc-error\" failed tools/call (-32000): remote exploded",
      server: "call-rpc-error"
    })
  })

  it.each([
    ["call-invalid-params-unknown-tool", -32_602],
    ["call-method-not-found-unknown-tool", -32_601]
  ])("maps a remote unknown-tool rejection in %s mode to tool_not_found", async (mode, code) => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode(mode)
      return yield* Effect.flip(client.callTool("add", {}))
    })))
    expect(error).toMatchObject({ code: "tool_not_found", server: mode })
    if (mode === "call-invalid-params-unknown-tool") {
      expect(error.message).toBe(`MCP server "${mode}" failed tools/call (${code}): Unknown tool: add`)
    }
  })

  it("keeps an ordinary invalid-arguments rejection as tool_failed", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("call-invalid-params")
      return yield* Effect.flip(client.callTool("add", {}))
    })))
    expect(error).toMatchObject({
      code: "tool_failed",
      server: "call-invalid-params",
      message: "MCP server \"call-invalid-params\" failed tools/call (-32602): Tool arguments are invalid"
    })
  })

  it.each([
    ["list-not-array", "MCP server \"list-not-array\" returned a tools/list result with no tools array"],
    [
      "list-result-not-object",
      "MCP server \"list-result-not-object\" returned a tools/list result with no tools array"
    ],
    ["list-no-name", "MCP server \"list-no-name\" returned tools[0] with no name"],
    ["list-empty-name", "MCP server \"list-empty-name\" returned tools[0] with no name"],
    ["list-null-entry", "MCP server \"list-null-entry\" returned tools[1], which is not an object"],
    ["list-number-entry", "MCP server \"list-number-entry\" returned tools[1], which is not an object"],
    ["list-array-entry", "MCP server \"list-array-entry\" returned tools[1], which is not an object"],
    ["list-duplicate-names", "MCP server \"list-duplicate-names\" returned two tools named \"add\""]
  ])("rejects a malformed catalog in %s mode", async (mode, message) => {
    const error = await execute(Effect.scoped(Effect.flip(connectNode(mode))))
    expect(error).toMatchObject({ code: "invalid_response", message, server: mode })
  })

  it.each([
    [
      "malformed-initialize-result",
      "MCP server \"malformed-initialize-result\" returned a malformed initialize result: result is not an object"
    ],
    [
      "malformed-protocol-version",
      "MCP server \"malformed-protocol-version\" returned a malformed initialize result: protocolVersion is not a string"
    ],
    [
      "malformed-capabilities",
      "MCP server \"malformed-capabilities\" returned a malformed initialize result: capabilities is not an object"
    ],
    [
      "no-tools-capability",
      "MCP server \"no-tools-capability\" does not serve tools: its initialize result declares no tools capability"
    ],
    [
      "wrong-protocol-version",
      "MCP server \"wrong-protocol-version\" speaks protocol \"1999-01-01\"; this client speaks 2025-06-18, 2025-03-26, 2024-11-05"
    ]
  ])("rejects the invalid initialize result in %s mode", async (mode, message) => {
    const error = await execute(Effect.scoped(Effect.flip(connectNode(mode))))
    expect(error).toMatchObject({ code: "protocol_error", server: mode, message })
  })

  it("accepts an older supported protocol revision", async () => {
    const client = await execute(Effect.scoped(connectNode("older-protocol-version")))
    expect(client.tools.map((tool) => tool.name)).toEqual(["add", "error"])
  })

  it("inherits PATH while merging configured environment values", async () => {
    const result = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("echo-env", [], {
        env: { MCP_FIXTURE_TOKEN: "fixture-token" }
      })
      return yield* client.callTool("add", {})
    })))
    expect(result.content).toEqual([expect.objectContaining({
      token: "fixture-token",
      hasPath: true
    })])
  })

  it("starts the child in the configured working directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-mcp-cwd-"))
    try {
      const result = await execute(Effect.scoped(Effect.gen(function*() {
        const client = yield* connectNode("echo-env", [], { cwd: directory })
        return yield* client.callTool("add", {})
      })))
      const block = result.content[0] as { readonly cwd: string }
      expect(realpathSync(block.cwd)).toBe(realpathSync(directory))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("maps a tools/list JSON-RPC error to protocol_error", async () => {
    const error = await execute(Effect.scoped(Effect.flip(connectNode("list-rpc-error"))))
    expect(error).toMatchObject({
      code: "protocol_error",
      server: "list-rpc-error",
      message: "MCP server \"list-rpc-error\" failed tools/list (-32601): catalog unavailable"
    })
  })

  it.each([
    ["call-rpc-error-string-data", "context"],
    ["call-rpc-error-number-data", "7"],
    ["call-rpc-error-boolean-data", "true"]
  ])("appends bounded scalar error data in %s mode", async (mode, rendered) => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode(mode)
      return yield* Effect.flip(client.callTool("add", {}))
    })))
    expect(error.message).toBe(`MCP server "${mode}" failed tools/call (-32000): remote exploded [data: ${rendered}]`)
  })

  it.each([
    "call-rpc-error-long-data",
    "call-rpc-error-object-data",
    "call-rpc-error-array-data"
  ])("does not append unsafe error data in %s mode", async (mode) => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode(mode)
      return yield* Effect.flip(client.callTool("add", {}))
    })))
    expect(error.message).toBe(`MCP server "${mode}" failed tools/call (-32000): remote exploded`)
  })

  it("closes the connection on a malformed JSON-RPC reply", async () => {
    const error = await execute(Effect.scoped(Effect.flip(connectNode("malformed-reply"))))
    expect(error).toMatchObject({
      code: "protocol_error",
      server: "malformed-reply",
      message:
        "MCP server \"malformed-reply\" sent a malformed JSON-RPC reply: a reply carried a malformed error object"
    })
  })

  it("correlates a reply whose id is a canonical digit string", async () => {
    const client = await execute(Effect.scoped(connectNode("string-reply-id")))
    expect(client.tools.map((tool) => tool.name)).toEqual(["add", "error"])
  })

  it.each([
    [
      "call-result-not-object",
      "MCP server \"call-result-not-object\" returned a tools/call result that is not an object"
    ],
    [
      "call-content-not-array",
      "MCP server \"call-content-not-array\" returned a tools/call result with no content array"
    ],
    [
      "call-content-bad-entry",
      "MCP server \"call-content-bad-entry\" returned a tools/call result whose content[1] is not an object"
    ],
    [
      "call-content-string-entry",
      "MCP server \"call-content-string-entry\" returned a tools/call result whose content[0] is not an object"
    ],
    [
      "call-content-number-entry",
      "MCP server \"call-content-number-entry\" returned a tools/call result whose content[0] is not an object"
    ],
    [
      "call-content-array-entry",
      "MCP server \"call-content-array-entry\" returned a tools/call result whose content[0] is not an object"
    ],
    [
      "call-is-error-not-boolean",
      "MCP server \"call-is-error-not-boolean\" returned a tools/call result whose isError is not a boolean"
    ],
    [
      "call-structured-content-not-object",
      "MCP server \"call-structured-content-not-object\" returned a tools/call result whose structuredContent is not a JSON object"
    ]
  ])("rejects a malformed tools/call result in %s mode", async (mode, message) => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode(mode)
      return yield* Effect.flip(client.callTool("add", {}))
    })))
    expect(error).toMatchObject({ code: "invalid_response", server: mode, message })
  })

  it("preserves structured tool output", async () => {
    const result = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("call-structured-content")
      return yield* client.callTool("add", {})
    })))
    expect(result.structuredContent).toEqual({ sum: 5 })
  })

  it("validates and preserves structured output through the McpFlows result schema", async () => {
    const { client, result } = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("structured-valid")
      const result = yield* client.callTool("add", {})
      return { client, result }
    })))

    expect(client.tools[0]?.outputSchema).toEqual({
      type: "object",
      properties: { answer: { type: "number" } },
      required: ["answer"]
    })
    expect(Schema.decodeUnknownSync(McpFlows.Result)(result)).toEqual({
      content: [{ type: "text", text: "5" }],
      isError: false,
      structuredContent: { answer: 5 }
    })
  })

  it("rejects structured output at the exact property whose type is invalid", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("structured-invalid-type")
      return yield* Effect.flip(client.callTool("add", {}))
    })))

    expect(error).toMatchObject({
      code: "invalid_response",
      server: "structured-invalid-type",
      message:
        "MCP server \"structured-invalid-type\" returned structuredContent that its own outputSchema rejects at structuredContent.answer: expected number"
    })
  })

  it("rejects structured output that omits a required property", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("structured-missing-required")
      return yield* Effect.flip(client.callTool("add", {}))
    })))

    expect(error).toMatchObject({
      code: "invalid_response",
      message:
        "MCP server \"structured-missing-required\" returned structuredContent that its own outputSchema rejects at structuredContent.answer: required property is missing"
    })
  })

  it("rejects structured output outside a declared enum", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("structured-enum-invalid")
      return yield* Effect.flip(client.callTool("add", {}))
    })))

    expect(error).toMatchObject({
      code: "invalid_response",
      message:
        "MCP server \"structured-enum-invalid\" returned structuredContent that its own outputSchema rejects at structuredContent.answer: expected a declared enum value"
    })
  })

  it("names the invalid array index in structured output", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("structured-array-invalid")
      return yield* Effect.flip(client.callTool("add", {}))
    })))

    expect(error).toMatchObject({
      code: "invalid_response",
      message:
        "MCP server \"structured-array-invalid\" returned structuredContent that its own outputSchema rejects at structuredContent.values[1]: expected number"
    })
  })

  it("ignores unsupported outputSchema keywords", async () => {
    const result = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("structured-unsupported-keyword")
      return yield* client.callTool("add", {})
    })))

    expect(result.structuredContent).toEqual({ answer: "x" })
  })

  it("accepts arbitrary structured output when the tool declared no outputSchema", async () => {
    const result = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("structured-no-output-schema")
      return yield* client.callTool("add", {})
    })))

    expect(result.structuredContent).toEqual({ arbitrary: ["accepted"] })
  })

  it("accepts a structured-only tools/call result with empty content", async () => {
    const result = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("structured-only")
      return yield* client.callTool("add", {})
    })))

    expect(result).toEqual({ content: [], isError: false, structuredContent: { answer: 5 } })
  })

  it("still rejects a tools/call result with neither content nor structuredContent", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("structured-neither")
      return yield* Effect.flip(client.callTool("add", {}))
    })))

    expect(error).toMatchObject({
      code: "invalid_response",
      message: "MCP server \"structured-neither\" returned a tools/call result with no content array"
    })
  })

  it.each([
    ["list-two-pages", ["add", "error"]],
    ["list-three-pages", ["add", "error", "third"]],
    ["list-empty-middle-page", ["add", "error"]]
  ])("walks every tools/list page in %s mode", async (mode, names) => {
    const client = await execute(Effect.scoped(connectNode(mode)))
    expect(client.tools.map((tool) => tool.name)).toEqual(names)
  })

  it.each([
    ["list-repeated-cursor", "MCP server \"list-repeated-cursor\" repeated the tools/list cursor \"again\""],
    [
      "list-bad-cursor",
      "MCP server \"list-bad-cursor\" returned a tools/list cursor that is not a non-empty string"
    ],
    [
      "list-empty-cursor",
      "MCP server \"list-empty-cursor\" returned a tools/list cursor that is not a non-empty string"
    ],
    [
      "list-duplicate-across-pages",
      "MCP server \"list-duplicate-across-pages\" returned two tools named \"add\""
    ]
  ])("rejects an invalid paginated catalog in %s mode", async (mode, message) => {
    const error = await execute(Effect.scoped(Effect.flip(connectNode(mode))))
    expect(error).toMatchObject({ code: "invalid_response", server: mode, message })
  })

  it("caps the number of tools/list pages", async () => {
    const error = await execute(Effect.scoped(Effect.flip(
      connectNode("list-unbounded-pages", [], { maxCatalogPages: 2 })
    )))
    expect(error).toMatchObject({
      code: "invalid_response",
      server: "list-unbounded-pages",
      message: "MCP server \"list-unbounded-pages\" returned more than 2 tools/list pages"
    })
  })

  it("reports spawn failures", async () => {
    const error = await execute(Effect.scoped(Effect.flip(Effect.provide(
      McpClient.connect({ server: "missing", command: "flows-command-that-does-not-exist", args: [] }),
      NodeServices.layer
    ))))
    expect(error).toMatchObject({ code: "spawn_failed", server: "missing" })
  })

  it("includes a bounded stderr diagnostic when a server exits during startup", async () => {
    const error = await execute(Effect.scoped(Effect.flip(
      connectNode("stderr-exit", [], { handshakeTimeoutMs: 2_000 })
    )))

    expect(error.code).toBe("connection_closed")
    expect(error.server).toBe("stderr-exit")
    expect(error.message).toBe(
      "MCP server \"stderr-exit\" stdout closed (stderr: distinctive startup diagnostic)"
    )
  })

  it("keeps only the configured tail of a large stderr diagnostic", async () => {
    const error = await execute(Effect.scoped(Effect.flip(
      connectNode("stderr-tail-exit", [], { handshakeTimeoutMs: 2_000, maxStderrBytes: 26 })
    )))

    expect(error.code).toBe("connection_closed")
    expect(error.server).toBe("stderr-tail-exit")
    expect(error.message).toBe(
      "MCP server \"stderr-tail-exit\" stdout closed (stderr: KEEP-THIS-TAIL-1234567890)"
    )
    expect(error.message.length).toBeLessThanOrEqual(100)
  })

  it("fails a pending call when the server exits", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("exit-mid-call")
      return yield* Effect.flip(client.callTool("add", { a: 1, b: 2 }).pipe(Effect.timeout("2 seconds")))
    })))
    expect(error).toMatchObject({ code: "connection_closed", server: "exit-mid-call" })
  })

  it("fails every request immediately after the server has exited", async () => {
    const errors = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("exit-after-list")
      yield* Effect.sleep("100 millis")
      const first = yield* Effect.flip(client.callTool("add", {}).pipe(Effect.timeout("1 second")))
      const second = yield* Effect.flip(client.callTool("add", {}).pipe(Effect.timeout("1 second")))
      return [first, second]
    })))
    expect(errors).toEqual([
      expect.objectContaining({ code: "connection_closed", server: "exit-after-list" }),
      expect.objectContaining({ code: "connection_closed", server: "exit-after-list" })
    ])
  })

  it("fails a pending call when the server closes stdin", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("close-stdin")
      yield* Effect.sleep("100 millis")
      return yield* Effect.flip(client.callTool("add", { a: 1, b: 2 }).pipe(Effect.timeout("2 seconds")))
    })))
    expect(error).toMatchObject({ code: "connection_closed", server: "close-stdin" })
  })

  it("applies the configured request deadline", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const client = yield* connectNode("hang", [], { requestTimeoutMs: 50 })
      return yield* Effect.flip(client.callTool("add", {}))
    })))
    expect(error).toMatchObject({
      code: "timeout",
      server: "hang",
      message: "MCP server \"hang\" did not answer tools/call within 50ms"
    })
    expect(error.message).not.toContain(" (stderr:")
  })

  it("delivers one cancellation to a real server after tools/call times out", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smithers-mcp-cancel-"))
    const marker = join(directory, "cancelled.ndjson")
    try {
      const error = await execute(Effect.scoped(Effect.gen(function*() {
        const client = yield* connectNode("capture-cancellation", [marker], { requestTimeoutMs: 50 })
        const failure = yield* Effect.flip(client.callTool("add", { private: "never-forward" }))
        yield* Effect.promise(() => vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 2_000 }))
        return failure
      })))
      const frames = readFileSync(marker, "utf8").trim().split("\n").map((line) => JSON.parse(line) as unknown)

      expect(error).toMatchObject({
        code: "timeout",
        server: "capture-cancellation",
        message: "MCP server \"capture-cancellation\" did not answer tools/call within 50ms"
      })
      expect(frames).toEqual([{
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 3, reason: "request no longer awaited" }
      }])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("applies the configured handshake deadline", async () => {
    const error = await execute(Effect.scoped(Effect.flip(
      connectNode("hang-handshake", [], { handshakeTimeoutMs: 50 })
    )))
    expect(error).toMatchObject({ code: "timeout", server: "hang-handshake" })
  })

  it("uses the per-notification deadline when initialized is blocked behind a stopped reader", async () => {
    const error = await execute(Effect.scoped(Effect.gen(function*() {
      const transport = yield* connectTransportNode("stop-reading-after-initialize", {
        queueCapacity: 1,
        requestTimeoutMs: 5_000
      })
      yield* transport.request("initialize", {}, 500)
      yield* transport.notify("fill-pipe", { value: "x".repeat(900_000) }, 1_000)
      yield* transport.notify("queued-behind-fill", {}, 1_000)
      const failure = yield* Effect.flip(transport.notify("notifications/initialized", undefined, 50))
      yield* Effect.sleep("500 millis")
      return failure
    })))

    expect(error).toMatchObject({
      code: "timeout",
      server: "stop-reading-after-initialize",
      message: "MCP server \"stop-reading-after-initialize\" did not answer notifications/initialized within 50ms"
    })
  })

  it("closes on an oversized inbound frame", async () => {
    const error = await execute(Effect.scoped(Effect.flip(
      connectNode("oversized-frame", [], { maxFrameBytes: 128 })
    )))
    expect(error).toMatchObject({ code: "protocol_error", server: "oversized-frame" })
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
