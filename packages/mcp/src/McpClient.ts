/**
 * A minimal MCP client covering the `initialize` handshake, `tools/list`, and
 * `tools/call`, over {@link StdioTransport}.
 *
 * This is deliberately not a general MCP SDK. Smithers has exactly one
 * consumer of an MCP session — {@link McpFlows}, which needs a tool catalog
 * and a way to invoke one entry from it — so the client exposes only that.
 * Resources, prompts, sampling, and roots are not wired up; add them here
 * when a flow adapter needs them, not speculatively.
 *
 * @since 1.0.0-rc.0
 */
import { Effect, Result, Schema } from "effect"
import type { Scope } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as StdioTransport from "./internal/StdioTransport.ts"
import { McpError } from "./McpError.ts"

/**
 * One remote tool as the server describes it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ToolDescription {
  readonly name: string
  readonly description: string | undefined
  /** The tool's parameter shape, as the server's own JSON Schema document. */
  readonly inputSchema: Record<string, unknown>
  /** The tool's structured result shape, when the server disclosed one. */
  readonly outputSchema: Record<string, unknown> | undefined
}

/**
 * The result of one `tools/call`.
 *
 * MCP tool content is a small union (text, image, embedded resource, …); this
 * client passes every block through by shape rather than modeling the union,
 * since {@link McpFlows} only needs to hand the blocks back to the caller.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ToolResult {
  readonly content: ReadonlyArray<Record<string, unknown>>
  readonly isError: boolean
  readonly structuredContent: Record<string, unknown> | undefined
}

/**
 * A live MCP session, holding the tool catalog fetched at connect time and a
 * way to call one of its entries.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface McpClient {
  readonly server: string
  readonly tools: ReadonlyArray<ToolDescription>
  /**
   * Calls one catalogued tool. An unknown name fails with `tool_not_found`
   * before a JSON-RPC frame is written.
   */
  readonly callTool: (name: string, args: Record<string, unknown>) => Effect.Effect<ToolResult, McpError>
}

/**
 * Options accepted by {@link connect}.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ConnectOptions {
  /** The name this server is known by, for flow naming and error messages. */
  readonly server: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd?: string | undefined
  /** Values merged into the inherited child environment rather than replacing it. */
  readonly env?: Record<string, string | undefined> | undefined
  /** Deadline for each initialize/catalog request. See {@link defaultHandshakeTimeoutMs}. */
  readonly handshakeTimeoutMs?: number | undefined
  /** Deadline for each later tool request. See {@link defaultRequestTimeoutMs}. */
  readonly requestTimeoutMs?: number | undefined
  /** Maximum outbound frames waiting to be written. See {@link defaultQueueCapacity}. */
  readonly queueCapacity?: number | undefined
  /** Maximum UTF-8 bytes in one inbound JSON-RPC frame. See {@link defaultMaxFrameBytes}. */
  readonly maxFrameBytes?: number | undefined
  /** Maximum UTF-8 bytes in one outbound JSON-RPC frame. See {@link defaultMaxOutboundFrameBytes}. */
  readonly maxOutboundFrameBytes?: number | undefined
  /** Maximum diagnostic stderr bytes retained in memory. See {@link defaultMaxStderrBytes}. */
  readonly maxStderrBytes?: number | undefined
  /** Maximum tools accepted across every catalog page. See {@link defaultMaxTools}. */
  readonly maxTools?: number | undefined
  /**
   * Maximum UTF-8 bytes in a tool name. Names also cannot contain `/`, C0
   * control characters, or U+007F. See {@link defaultMaxToolNameBytes}.
   */
  readonly maxToolNameBytes?: number | undefined
  /** Maximum pages walked while fetching the catalog. See {@link defaultMaxCatalogPages}. */
  readonly maxCatalogPages?: number | undefined
}

const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))

/**
 * Authoritative decoder for a persisted MCP server entry.
 *
 * The schema requires non-empty server and command names, string arguments,
 * a plain string-valued environment record, and positive-integer limits.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const ConnectOptionsSchema = Schema.Struct({
  server: Schema.NonEmptyString,
  command: Schema.NonEmptyString,
  args: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.NonEmptyString),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  handshakeTimeoutMs: Schema.optional(PositiveInteger),
  requestTimeoutMs: Schema.optional(PositiveInteger),
  queueCapacity: Schema.optional(PositiveInteger),
  maxFrameBytes: Schema.optional(PositiveInteger),
  maxOutboundFrameBytes: Schema.optional(PositiveInteger),
  maxStderrBytes: Schema.optional(PositiveInteger),
  maxTools: Schema.optional(PositiveInteger),
  maxToolNameBytes: Schema.optional(PositiveInteger),
  maxCatalogPages: Schema.optional(PositiveInteger)
})

/**
 * Identity disclosed to every MCP server during initialization.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const clientInfo = { name: "smithers", version: "1.0.0-rc.0" }

/**
 * MCP revisions whose `tools/list` and `tools/call` shapes this client
 * decodes. The client always proposes `2025-06-18`.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const supportedProtocolVersions: ReadonlyArray<string> = ["2025-06-18", "2025-03-26", "2024-11-05"]

/**
 * Default deadline for each MCP handshake request.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultHandshakeTimeoutMs = 10_000

/**
 * Default deadline for each tool request.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultRequestTimeoutMs = StdioTransport.defaultRequestTimeoutMs

/**
 * Default number of outbound frames allowed to wait in memory.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultQueueCapacity = StdioTransport.defaultQueueCapacity

/**
 * Default maximum inbound JSON-RPC frame size.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxFrameBytes = StdioTransport.defaultMaxFrameBytes

/**
 * Default maximum outbound JSON-RPC frame size.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxOutboundFrameBytes = StdioTransport.defaultMaxOutboundFrameBytes

/**
 * Default maximum child-stderr tail retained for connection diagnostics.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxStderrBytes = StdioTransport.defaultMaxStderrBytes

/**
 * Default maximum number of tools in a remote catalog.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxTools = 256

/**
 * Default maximum UTF-8 byte length of one remote tool name.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxToolNameBytes = 128

/**
 * Default maximum number of remote catalog pages.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxCatalogPages = 32

const invalidResponse = (server: string, message: string): McpError =>
  new McpError({ code: "invalid_response", message, server })

const protocolError = (server: string, message: string): McpError =>
  new McpError({ code: "protocol_error", message, server })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const positiveInteger = (value: number): boolean => Number.isInteger(value) && value > 0

const asInitialize = (server: string, result: unknown): Result.Result<void, McpError> => {
  if (!isRecord(result)) {
    return Result.fail(protocolError(
      server,
      `MCP server "${server}" returned a malformed initialize result: result is not an object`
    ))
  }
  if (typeof result.protocolVersion !== "string") {
    return Result.fail(protocolError(
      server,
      `MCP server "${server}" returned a malformed initialize result: protocolVersion is not a string`
    ))
  }
  if (!supportedProtocolVersions.includes(result.protocolVersion)) {
    return Result.fail(protocolError(
      server,
      `MCP server "${server}" speaks protocol "${result.protocolVersion}"; this client speaks ${
        supportedProtocolVersions.join(", ")
      }`
    ))
  }
  if (!isRecord(result.capabilities)) {
    return Result.fail(protocolError(
      server,
      `MCP server "${server}" returned a malformed initialize result: capabilities is not an object`
    ))
  }
  if (!Object.hasOwn(result.capabilities, "tools") || !isRecord(result.capabilities.tools)) {
    return Result.fail(protocolError(
      server,
      `MCP server "${server}" does not serve tools: its initialize result declares no tools capability`
    ))
  }
  return Result.succeed(undefined)
}

type CatalogLimits = {
  readonly maxTools: number
  readonly maxToolNameBytes: number
}

type ToolPage = {
  readonly nextCursor: string | undefined
}

const nameEncoder = new TextEncoder()

const hasForbiddenToolNameCharacter = (name: string): boolean => {
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index)
    if (name[index] === "/" || code <= 0x1f || code === 0x7f) return true
  }
  return false
}

const asToolPage = (
  server: string,
  result: unknown,
  limits: CatalogLimits,
  seen: Set<string>,
  described: Array<ToolDescription>
): Result.Result<ToolPage, McpError> => {
  const tools = isRecord(result) ? result.tools : undefined
  if (!Array.isArray(tools)) {
    return Result.fail(invalidResponse(
      server,
      `MCP server "${server}" returned a tools/list result with no tools array`
    ))
  }
  for (const [index, tool] of tools.entries()) {
    if (described.length >= limits.maxTools) {
      return Result.fail(invalidResponse(
        server,
        `MCP server "${server}" returned more than ${limits.maxTools} tools`
      ))
    }
    if (!isRecord(tool)) {
      return Result.fail(invalidResponse(
        server,
        `MCP server "${server}" returned tools[${index}], which is not an object`
      ))
    }
    const record = tool
    if (typeof record.name !== "string" || record.name === "") {
      return Result.fail(invalidResponse(server, `MCP server "${server}" returned tools[${index}] with no name`))
    }
    if (nameEncoder.encode(record.name).byteLength > limits.maxToolNameBytes) {
      return Result.fail(invalidResponse(
        server,
        `MCP server "${server}" returned a tool name longer than ${limits.maxToolNameBytes} bytes`
      ))
    }
    if (hasForbiddenToolNameCharacter(record.name)) {
      return Result.fail(invalidResponse(
        server,
        `MCP server "${server}" returned a tool name containing a control character or "/"`
      ))
    }
    if (seen.has(record.name)) {
      return Result.fail(invalidResponse(
        server,
        `MCP server "${server}" returned two tools named "${record.name}"`
      ))
    }
    if (
      !isRecord(record.inputSchema) ||
      (Object.hasOwn(record.inputSchema, "type") && record.inputSchema.type !== "object")
    ) {
      return Result.fail(invalidResponse(
        server,
        `MCP server "${server}" returned a tool whose inputSchema is not a JSON Schema object of type "object"`
      ))
    }
    let outputSchema: Record<string, unknown> | undefined
    if (Object.hasOwn(record, "outputSchema")) {
      if (!isRecord(record.outputSchema)) {
        return Result.fail(invalidResponse(
          server,
          `MCP server "${server}" returned a tool whose outputSchema is not a JSON object`
        ))
      }
      outputSchema = record.outputSchema
    }
    seen.add(record.name)
    described.push({
      name: record.name,
      description: typeof record.description === "string" ? record.description : undefined,
      inputSchema: record.inputSchema,
      outputSchema
    })
  }

  const nextCursor = isRecord(result) && Object.hasOwn(result, "nextCursor") ? result.nextCursor : undefined
  if (nextCursor === undefined) return Result.succeed({ nextCursor: undefined })
  if (typeof nextCursor !== "string" || nextCursor === "") {
    return Result.fail(invalidResponse(
      server,
      `MCP server "${server}" returned a tools/list cursor that is not a non-empty string`
    ))
  }
  return Result.succeed({ nextCursor })
}

const asToolResult = (server: string, result: unknown): Result.Result<ToolResult, McpError> => {
  if (!isRecord(result)) {
    return Result.fail(invalidResponse(
      server,
      `MCP server "${server}" returned a tools/call result that is not an object`
    ))
  }
  if (!Array.isArray(result.content)) {
    return Result.fail(invalidResponse(
      server,
      `MCP server "${server}" returned a tools/call result with no content array`
    ))
  }
  const content: Array<Record<string, unknown>> = []
  for (const [index, block] of result.content.entries()) {
    if (!isRecord(block)) {
      return Result.fail(invalidResponse(
        server,
        `MCP server "${server}" returned a tools/call result whose content[${index}] is not an object`
      ))
    }
    content.push(block)
  }
  if (Object.hasOwn(result, "isError") && typeof result.isError !== "boolean") {
    return Result.fail(invalidResponse(
      server,
      `MCP server "${server}" returned a tools/call result whose isError is not a boolean`
    ))
  }
  let structuredContent: Record<string, unknown> | undefined
  if (Object.hasOwn(result, "structuredContent")) {
    if (!isRecord(result.structuredContent)) {
      return Result.fail(invalidResponse(
        server,
        `MCP server "${server}" returned a tools/call result whose structuredContent is not a JSON object`
      ))
    }
    structuredContent = result.structuredContent
  }
  return Result.succeed({
    content,
    isError: result.isError === true,
    structuredContent
  })
}

interface JsonObject {
  [key: string]: JsonValue
}

type JsonValue = null | boolean | number | string | Array<JsonValue> | JsonObject

type JsonIssue = {
  readonly path: string
  readonly reason: string
}

const jsonFailure = (path: string, reason: string): Result.Result<JsonValue, JsonIssue> => Result.fail({ path, reason })

const snapshotJson = (
  value: unknown,
  path: string,
  ancestors: Set<object>
): Result.Result<JsonValue, JsonIssue> => {
  if (value === null) return Result.succeed(null)
  if (typeof value === "boolean" || typeof value === "string") return Result.succeed(value)
  if (typeof value === "number") {
    return Number.isFinite(value) ? Result.succeed(value) : jsonFailure(path, "a non-finite number")
  }
  if (typeof value === "undefined") return jsonFailure(path, "undefined")
  if (typeof value === "bigint") return jsonFailure(path, "a bigint")
  if (typeof value === "function") return jsonFailure(path, "a function")
  if (typeof value === "symbol") return jsonFailure(path, "a symbol")

  if (ancestors.has(value)) return jsonFailure(path, "a cyclic reference")
  if (Array.isArray(value)) {
    ancestors.add(value)
    const copied: Array<JsonValue> = []
    for (const [index, member] of value.entries()) {
      const snapshot = snapshotJson(member, `${path}[${index}]`, ancestors)
      if (Result.isFailure(snapshot)) {
        ancestors.delete(value)
        return snapshot
      }
      copied.push(snapshot.success)
    }
    ancestors.delete(value)
    return Result.succeed(copied)
  }

  const object = value as Record<string, unknown>
  const prototype = Object.getPrototypeOf(object)
  if (prototype !== Object.prototype && prototype !== null) {
    return jsonFailure(path, "an object with a non-plain prototype")
  }
  const symbol = Object.getOwnPropertySymbols(object).find((key) =>
    Object.prototype.propertyIsEnumerable.call(object, key)
  )
  if (symbol !== undefined) return jsonFailure(path, "a symbol-keyed property")

  ancestors.add(object)
  const copied: JsonObject = {}
  for (const key of Object.keys(object)) {
    const snapshot = snapshotJson(object[key], `${path}.${key}`, ancestors)
    if (Result.isFailure(snapshot)) {
      ancestors.delete(object)
      return snapshot
    }
    Object.defineProperty(copied, key, {
      configurable: true,
      enumerable: true,
      value: snapshot.success,
      writable: true
    })
  }
  ancestors.delete(object)
  return Result.succeed(copied)
}

const boundedPath = (path: string): string => path.length <= 120 ? path : `${path.slice(0, 117)}...`

const snapshotArguments = (
  server: string,
  args: Record<string, unknown>
): Result.Result<Record<string, unknown>, McpError> => {
  const snapshot = snapshotJson(args, "arguments", new Set())
  if (Result.isFailure(snapshot)) {
    return Result.fail(protocolError(
      server,
      `MCP server "${server}" was sent a tool argument that is not JSON at ${
        boundedPath(snapshot.failure.path)
      }: ${snapshot.failure.reason}`
    ))
  }
  return Result.succeed(snapshot.success as Record<string, unknown>)
}

/**
 * Connects to an MCP server over stdio, completes the `initialize` handshake,
 * and fetches its tool catalog once, up front.
 *
 * The tool catalog is a snapshot: a server that changes its tools after
 * connecting (a `notifications/tools/list_changed` push) is not re-polled.
 * {@link McpFlows} rebuilds by reconnecting to refresh.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const connect = (
  options: ConnectOptions
): Effect.Effect<McpClient, McpError, ChildProcessSpawner | Scope.Scope> =>
  Effect.gen(function*() {
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? defaultHandshakeTimeoutMs
    const maxTools = options.maxTools ?? defaultMaxTools
    const maxToolNameBytes = options.maxToolNameBytes ?? defaultMaxToolNameBytes
    const maxCatalogPages = options.maxCatalogPages ?? defaultMaxCatalogPages
    const invalidOption = [
      ["handshakeTimeoutMs", handshakeTimeoutMs],
      ["maxTools", maxTools],
      ["maxToolNameBytes", maxToolNameBytes],
      ["maxCatalogPages", maxCatalogPages]
    ].find(([, value]) => !positiveInteger(value as number))
    if (invalidOption !== undefined) {
      return yield* Effect.fail(protocolError(
        options.server,
        `MCP option "${invalidOption[0]}" must be a positive integer`
      ))
    }

    const transport = yield* StdioTransport.connect(options)

    const initialized = yield* transport.request(
      "initialize",
      {
        protocolVersion: supportedProtocolVersions[0],
        capabilities: {},
        clientInfo
      },
      handshakeTimeoutMs
    )
    yield* Effect.fromResult(asInitialize(options.server, initialized))
    // A notification, not a request: the server never replies to it, and the
    // handshake is not complete until the client sends it.
    yield* transport.notify("notifications/initialized", undefined, handshakeTimeoutMs)

    const tools: Array<ToolDescription> = []
    const toolNames = new Set<string>()
    const cursors = new Set<string>()
    let params: Record<string, unknown> = {}
    let pageCount = 0
    while (true) {
      const listed = yield* transport.request("tools/list", params, handshakeTimeoutMs)
      pageCount += 1
      const page = yield* Effect.fromResult(asToolPage(
        options.server,
        listed,
        { maxTools, maxToolNameBytes },
        toolNames,
        tools
      ))
      if (page.nextCursor === undefined) break
      if (cursors.has(page.nextCursor)) {
        return yield* Effect.fail(invalidResponse(
          options.server,
          `MCP server "${options.server}" repeated the tools/list cursor "${page.nextCursor}"`
        ))
      }
      if (pageCount >= maxCatalogPages) {
        return yield* Effect.fail(invalidResponse(
          options.server,
          `MCP server "${options.server}" returned more than ${maxCatalogPages} tools/list pages`
        ))
      }
      cursors.add(page.nextCursor)
      params = { cursor: page.nextCursor }
    }

    const callTool = (name: string, args: Record<string, unknown>): Effect.Effect<ToolResult, McpError> => {
      if (!toolNames.has(name)) {
        return Effect.fail(
          new McpError({
            code: "tool_not_found",
            message: `MCP server "${options.server}" has no tool "${name}"`,
            server: options.server
          })
        )
      }
      const snapshot = snapshotArguments(options.server, args)
      if (Result.isFailure(snapshot)) return Effect.fail(snapshot.failure)
      return Effect.flatMap(
        transport.request("tools/call", { name, arguments: snapshot.success }),
        (result) => Effect.fromResult(asToolResult(options.server, result))
      )
    }

    return { server: options.server, tools, callTool }
  })
