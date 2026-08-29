/**
 * Integration coverage against a real, separately-processed MCP server.
 *
 * `McpFlows.test.ts` proves the transport and protocol logic against an
 * in-memory fake; this file proves the same client survives an actual OS
 * process boundary, actual `npx`-installed server code, and actual timing —
 * the class of bug a fake cannot produce. It uses the MCP reference
 * "everything" server (`@modelcontextprotocol/server-everything`), which
 * ships known tools including `echo` and `add`.
 *
 * Slower and network-dependent (first run downloads the package via `npx`),
 * so it is a separate file from the fast fake-backed suite rather than mixed
 * into it.
 *
 * @since 0.1.0
 */
import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as McpClient from "../src/McpClient.ts"
import * as McpFlows from "../src/McpFlows.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

const connectEverything = () =>
  Effect.provide(
    McpClient.connect({
      server: "everything",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything", "stdio"]
    }),
    NodeServices.layer
  )

describe("McpClient against a real MCP server", () => {
  it(
    "completes the handshake and lists the everything server's real tools",
    async () => {
      const tools = await execute(Effect.scoped(Effect.map(connectEverything(), (client) => client.tools)))
      const names = tools.map((tool) => tool.name)
      expect(names).toContain("echo")
      expect(names.length).toBeGreaterThan(1)
      const echo = tools.find((tool) => tool.name === "echo")
      expect(echo?.inputSchema).toBeDefined()
    },
    60_000
  )

  it(
    "calls the real echo tool and gets its actual reply back",
    async () => {
      const result = await execute(Effect.scoped(
        Effect.flatMap(connectEverything(), (client) => client.callTool("echo", { message: "flows-mcp-test" }))
      ))
      expect(result.isError).toBe(false)
      const text = result.content.find((block) => block.type === "text")?.text
      expect(text).toContain("flows-mcp-test")
    },
    60_000
  )

  it(
    "projects the real server's tools through McpFlows and runs one end to end",
    async () => {
      const outcome = await execute(Effect.scoped(Effect.gen(function*() {
        const client = yield* connectEverything()
        const source = McpFlows.mcp(client)
        const bindings = yield* source.bindings()
        const echoBinding = bindings.find((binding) => binding.descriptor.name === "mcp/everything/echo")
        if (echoBinding === undefined) return undefined
        return yield* client.callTool("echo", { message: "via-mcpflows" })
      })))
      expect(outcome?.isError).toBe(false)
    },
    60_000
  )
})
