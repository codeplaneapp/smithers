import { NodeServices } from "@effect/platform-node"
import { Effect, Redacted, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Diagnostics from "../src/Diagnostics.ts"
import * as Reporter from "../src/internal/DiagnosticReporter.ts"
import * as McpClient from "../src/McpClient.ts"
import { McpError } from "../src/McpError.ts"

const secret = "synthetic-private-value-DO-NOT-PUBLISH"
const SERVER = String.raw`
const readline = require("node:readline")
const mode = process.argv[1]
const secret = process.env.MCP_DIAGNOSTIC_TEST_SECRET
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n")
if (mode === "stderr") {
  process.stderr.write("API_TOKEN=" + secret + "\n", () => process.exit(1))
} else {
  const reader = readline.createInterface({ input: process.stdin })
  reader.on("line", (line) => {
    const request = JSON.parse(line)
    if (request.method === "initialize") {
      send({ jsonrpc: "2.0", id: request.id, result: {
        protocolVersion: mode === "version" ? secret : "2025-06-18", capabilities: { tools: {} }, serverInfo: {}
      } })
    } else if (request.method === "tools/list") {
      const tool = { name: "probe", inputSchema: { type: "object" }, outputSchema: { type: "object", required: [secret] } }
      send({ jsonrpc: "2.0", id: request.id, result: mode === "duplicate"
        ? { tools: [{ ...tool, name: secret }, { ...tool, name: secret }] }
        : mode === "cursor" ? { tools: [], nextCursor: secret } : { tools: [tool] } })
    } else if (request.method === "tools/call") {
      send({ jsonrpc: "2.0", id: request.id, ...(mode === "schema"
        ? { result: { content: [], structuredContent: {} } }
        : { error: { code: -32000, message: secret, data: "short-private-pin" } }) })
    }
  })
}
`

describe("MCP diagnostic privacy", () => {
  it.each(["stderr", "version", "duplicate", "cursor", "schema", "remote"])(
    "does not expose %s details through a typed/encoded error or ordinary observer serialization",
    async (mode) => {
      const events: Array<Diagnostics.Event> = []
      const error = await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          return yield* Effect.flip(Effect.gen(function*() {
            const client = yield* McpClient.connect({
              server: "private-test",
              command: process.execPath,
              args: ["-e", SERVER, mode],
              env: { MCP_DIAGNOSTIC_TEST_SECRET: secret },
              // Truncation can remove the credential prefix. The remainder must
              // still never be attached to an outward error.
              maxStderrBytes: secret.length + 1,
              handshakeTimeoutMs: 2_000,
              requestTimeoutMs: 2_000
            })
            return yield* client.callTool("probe", {})
          }))
        }).pipe(Effect.provide(NodeServices.layer), Effect.provide(Diagnostics.layer((event) => events.push(event))))
      ))
      expect(error).toBeInstanceOf(McpError)
      const encoded = Schema.encodeSync(McpError)(error)
      for (const display of [String(error), JSON.stringify(error), JSON.stringify(encoded), JSON.stringify(events)]) {
        expect(display).not.toContain(secret)
        expect(display).not.toContain("short-private-pin")
      }
      expect(events.length).toBeGreaterThan(0)
      expect(events.some((event) => Redacted.value(event.detail).includes(secret))).toBe(true)
    }
  )

  it("bounds private details, preserves UTF-8, and isolates observer and serialization defects", async () => {
    const events: Array<Diagnostics.Event> = []
    await Effect.runPromise(
      Effect.gen(function*() {
        const report = yield* Reporter.make("host")
        report("stderr", "x".repeat(16_383) + "😀" + secret)
        const circular: Record<string, unknown> = {}
        circular.self = circular
        report("invalid-response", circular)
        report("remote-error", { code: -32_000, message: secret })
      }).pipe(Effect.provide(Diagnostics.layer((event) => {
        events.push(event)
        if (event.source === "remote-error") throw new Error(secret)
      })))
    )
    expect(events).toHaveLength(2)
    expect(events[0]!.truncated).toBe(true)
    expect(Redacted.value(events[0]!.detail)).toBe("x".repeat(16_383))
    expect(events[1]!.truncated).toBe(false)
    expect(JSON.stringify(events)).not.toContain(secret)
  })

  it("discards details when no trusted host receiver is configured", async () => {
    await Effect.runPromise(Effect.gen(function*() {
      const report = yield* Reporter.make("host")
      report("stderr", secret)
    }))
  })
})
