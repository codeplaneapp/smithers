/**
 * An MCP tool reached the way a cell reaches it.
 *
 * `McpFlows.test.ts` runs a projected binding directly, which proves the
 * adapter talks to a server but skips the two gates a real call passes first:
 * the capability decision the cell boundary makes from the descriptor's
 * declaration, and the registry resolution `@smthrs/harness` `CellCalls`
 * performs before it dispatches. Both were where MCP tools actually failed.
 *
 * The declaration used to be the bare `"*"`. The boundary reads a declared
 * capability with `Capability.parse`, which takes an exact
 * `namespace:operation:resource` and answers `None` for anything else, and a
 * declaration it cannot parse counts as refused. Every MCP tool therefore
 * answered `capability_refused` before it ran, under every envelope including
 * an unrestricted one. The decision below is computed with the same two
 * functions `CellTurn` calls, against a real server over a real process.
 */
import { NodeServices } from "@effect/platform-node"
import * as Cell from "@smthrs/harness/Cell"
import * as CellCalls from "@smthrs/harness/CellCalls"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { Capability, CapabilitySet } from "@smthrs/kernel"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Option } from "effect"
import { describe, expect, it } from "vitest"
import * as McpFlows from "../src/McpFlows.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

/** A real MCP server in its own process: one `add` tool, nothing else. */
const SERVER = String.raw`
const readline = require("node:readline")
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n")
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line)
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture" } } })
    return
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "add", description: "Adds two numbers", inputSchema: { type: "object", properties: { a: {}, b: {} } } }] } })
    return
  }
  if (request.method === "tools/call") {
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: String(request.params.arguments.a + request.params.arguments.b) }], isError: false } })
  }
})
`

const connected = Effect.provide(
  McpFlows.connected({ server: "fixture", command: process.execPath, args: ["-e", SERVER] }),
  NodeServices.layer
)

/** A capability pattern written the way an envelope declares one. */
const pattern = (declared: string): Capability.CapabilityPattern => {
  const parts = declared.split(":")
  return new Capability.CapabilityPattern({
    action: `${parts[0]}:${parts[1]}` as Capability.PatternAction,
    resource: parts.slice(2).join(":")
  })
}

/**
 * The cell boundary's own decision, transcribed from
 * `@smthrs/harness` `CellTurn`: parse each declared capability, and refuse the
 * call when any one of them is unparseable or outside the envelope.
 */
const refusedBy = (
  envelope: ReadonlyArray<Capability.CapabilityPattern>,
  declared: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const set = CapabilitySet.fromPatterns(envelope)
  return declared.filter((capability) =>
    Option.match(Capability.parse(capability), {
      onNone: () => true,
      onSome: (parsed) => !CapabilitySet.allows(set, parsed)
    })
  )
}

const unrestricted = [new Capability.CapabilityPattern({ action: "*", resource: "*" })]
const readOnly = [pattern("fs:read:**")]

describe("the capability declaration an MCP tool carries", () => {
  it("is written in the vocabulary the boundary parses", () => {
    // The regression in one line: every declared string must parse, or the
    // boundary refuses the call whatever the envelope says.
    for (const capability of McpFlows.capabilities) {
      expect(Option.isSome(Capability.parse(capability)), capability).toBe(true)
    }
  })

  it("is authorized by an unrestricted envelope and refused by a narrow one", () => {
    expect(refusedBy(unrestricted, McpFlows.capabilities)).toEqual([])
    // Opaque remote code is not something a read-only run may reach, and the
    // refusal names what it would have needed.
    expect(refusedBy(readOnly, McpFlows.capabilities)).toContain("fs:write:**")
  })
})

describe("a cell calling a real MCP tool", () => {
  it("passes the capability gate and resolves through the production resolver", async () => {
    const result = await execute(Effect.scoped(Effect.gen(function*() {
      const source = yield* connected
      const catalog = yield* FlowBinding.catalog([source])
      const registry = FlowBinding.registry(Registry.makeNoop(), catalog)
      const descriptor = yield* registry.get("mcp/fixture/add")

      // Gate one: the declaration the cell was shown, against the run's
      // envelope. A refusal here never reaches the resolver.
      const refused = refusedBy(unrestricted, descriptor.capabilities)

      // Gate two: registry resolution and dispatch, exactly as a host composes
      // it. The call carries the declaration digest the boundary re-derives,
      // so a mismatch would be refused rather than dispatched.
      const resolver = CellCalls.make({ registry, catalog })
      const settled = yield* resolver.run(
        new Cell.Call({
          flowName: "mcp/fixture/add",
          input: { a: 2, b: 3 },
          capabilities: descriptor.capabilities,
          effects: descriptor.effects,
          placement: Option.none(),
          identity: new Cell.CallIdentity({
            session: "mcp-boundary",
            frame: 0,
            cell: "cell-0",
            ordinal: 0,
            declaration: Cell.declarationDigest(descriptor),
            layers: []
          })
        })
      )
      return { refused, settled }
    })))

    expect(result.refused).toEqual([])
    expect(result.settled.outcome).toBe("success")
    expect(result.settled.value).toEqual({ content: [{ type: "text", text: "5" }], isError: false })
  }, 30_000)
})
