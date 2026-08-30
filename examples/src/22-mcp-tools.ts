/**
 * Give a model tools that live in somebody else's process.
 *
 * An MCP server is a subprocess speaking newline-delimited JSON-RPC over stdio,
 * and its tools are code this repository does not own. None of that reaches the
 * cell. `McpFlows.mcp(client)` projects a connected session's catalog as an
 * ordinary `FlowBinding.Source`, one flow per tool, and a cell that calls an MCP
 * tool runs the identical two lines as a cell that reads a file: find it in
 * `ctx.flows`, invoke it with `ctx.call`. Compare
 * `25-agent-tools-in-sandbox.ts`: the composition below differs by one source
 * and one capability.
 *
 * Two details are the adapter's honesty rather than its convenience.
 *
 * A tool-level failure is DATA. MCP distinguishes "the call failed" from "the
 * tool ran and reported a problem", and the second one comes back as
 * `{ isError: true }` on a successful call, which is what the `explode` tool
 * below demonstrates. A transport failure is the other channel entirely and
 * fails the step.
 *
 * The declared authority is the conservative wildcard. An MCP tool is opaque
 * code, so `"*"` is the truthful declaration and a narrower guess would be a
 * claim nobody can back. It is also not a decision the ADAPTER can make: what a
 * given server may do depends on which server you connected and why. So the
 * host makes it, in {@link granting} below, and the run's envelope names that
 * grant rather than `*:*`. Connecting a server you trust and saying what you
 * trust it with are one decision, taken in one place.
 *
 * The server is `22-mcp-server.ts`, a dependency-free Node program in this
 * directory. It imports nothing from this repository, which is the point: the
 * process on the other end of an MCP session need not be ours.
 */
import { NodeServices } from "@effect/platform-node"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as Capability from "@smthrs/capability/Capability"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as McpClient from "@smthrs/mcp/McpClient"
import * as McpFlows from "@smthrs/mcp/McpFlows"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { durableEngine } from "./durable-layer.ts"

/** The name this session is known by. Every tool flow is scoped under it. */
export const serverName = "fixtures"

/** The fixture server's program file. */
export const serverProgram: string = join(dirname(fileURLToPath(import.meta.url)), "22-mcp-server.ts")

/** The capability this host is prepared to grant the fixture server's tools. */
export const grant = `proc:spawn:mcp/${serverName}`

/**
 * Re-declares a source's flows under the capabilities this host grants them.
 *
 * `McpFlows` declares every tool `"*"`, which is the repository's conservative
 * wildcard for authority a projector cannot describe. `MarkdownFlow` uses the
 * same spelling for a skill that declares none. The cell boundary checks a
 * declared capability as an EXACT `namespace:operation:resource` triple, so a
 * wildcard declaration parses as nothing and is refused by every envelope,
 * however wide. That refusal is the current behaviour and this example pins it.
 *
 * Narrowing here rather than widening the envelope is the right shape either
 * way: an envelope of `*:*` would grant the run everything, where this grants
 * exactly the tools of exactly this server.
 */
export const granting = (
  source: FlowBinding.Source,
  capabilities: ReadonlyArray<string>
): FlowBinding.Source => ({
  name: source.name,
  bindings: () =>
    Effect.map(source.bindings(), (bindings) =>
      bindings.map((binding) => ({
        descriptor: new Descriptor.FlowDescriptor({ ...binding.descriptor, capabilities }),
        run: binding.run
      })))
})

/** What the step must answer with. */
export const Reading = Schema.Struct({
  words: Schema.Number,
  slug: Schema.String,
  refused: Schema.Boolean
})

/** The step. Its prompt carries the title the tools are asked about. */
export const Describe = AgentAction.make("examples/DescribeTitle", {
  payload: { title: Schema.String },
  output: Reading,
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You prepare release titles. Use the tools rather than counting by eye."],
  prompt: ({ title }) => `Count the words in the title and slugify it.\nTITLE: ${title}`
})

/** The flow that runs the one step reaching the MCP server's tools. */
export const Titles = Flow.make("examples/Titles", {
  payload: { title: Schema.String },
  success: Reading,
  error: AgentAction.AgentFailure,
  body: (payload: { readonly title: string }) => Describe.call(payload)
})

const prepared: Route.PreparedRequest = {
  routeId: "examples",
  protocolId: "examples",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

/**
 * A scripted model that reads the title out of the request and calls three MCP
 * tools by their scoped flow names.
 *
 * `mcp/<server>/<tool>` is the naming rule, and it is scoped by server so two
 * servers may offer a tool of the same name without colliding. The cell reports
 * the third call's `isError` rather than treating it as a failure, because that
 * is what it is.
 */
export const scripted = (asked: Array<string>): Model.Model =>
  Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        const text = [
          ...request.system.map((part) => part.text),
          ...request.messages.flatMap((message) =>
            message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          )
        ].join("\n")
        asked.push(text)
        const title = /TITLE: (.+)/.exec(text)?.[1]?.trim() ?? ""
        const cell = [
          `const counted = await ctx.call("mcp/${serverName}/word_count", { text: ${JSON.stringify(title)} })`,
          `const slugged = await ctx.call("mcp/${serverName}/slugify", { text: ${JSON.stringify(title)} })`,
          `const refused = await ctx.call("mcp/${serverName}/explode", {})`,
          "ctx.done({",
          "  words: Number(counted.content[0].text),",
          "  slug: slugged.content[0].text,",
          "  refused: refused.isError",
          "})"
        ].join("\n")
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })

/** A scripted model that reports what one call came back with, verbatim. */
const reporting = (flow: string): Model.Model =>
  Model.make({
    stream: () =>
      Stream.suspend(() => {
        const cell = [
          "let outcome",
          `try { outcome = { ok: true, value: await ctx.call(${JSON.stringify(flow)}, { text: "one two" }) } }`,
          "catch (error) { outcome = { ok: false, message: String(error && error.message ? error.message : error) } }",
          "ctx.done({ words: 0, slug: JSON.stringify(outcome), refused: !outcome.ok })"
        ].join("\n")
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })

/** What one run of the step observed. */
export interface Summary {
  /** The schema-typed answer the step settled with. */
  readonly reading: typeof Reading.Type
  /** The tools the server disclosed at connect time, in catalog order. */
  readonly tools: ReadonlyArray<string>
  /** The flow names the projected source offers the model. */
  readonly flowNames: ReadonlyArray<string>
  /** The capabilities the adapter declares, before the host narrows them. */
  readonly declaredCapabilities: ReadonlyArray<string>
  /** Whether the catalog reached the model's request. */
  readonly disclosed: boolean
  /** What a cell got back when the same tools kept the adapter's wildcard. */
  readonly ungranted: string
}

/** Runs the step against a real MCP subprocess. */
export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    const asked: Array<string> = []

    // Connecting owns a subprocess, so it is scoped: the session lives exactly
    // as long as the surrounding scope, and a host composes it once beside its
    // other scoped services.
    const client = yield* McpClient.connect({
      server: serverName,
      command: process.execPath,
      args: [serverProgram]
    })
    const projected = McpFlows.mcp(client)
    const declared = yield* projected.bindings()
    const source = granting(projected, [grant])
    const bindings = yield* source.bindings()

    const registry = Registry.makeNoop({
      list: () => Effect.succeed([]),
      visible: () => Effect.succeed([]),
      getOption: () => Effect.succeed(Option.none())
    })

    const run = (
      flows: ReadonlyArray<FlowBinding.Source>,
      model: Model.Model,
      envelope: ReadonlyArray<Capability.CapabilityPattern>,
      executionId: string
    ) =>
      Effect.scoped(
        Titles.execute({ title: "Durable Flows Release Notes" }, { executionId }).pipe(
          Effect.provide(
            Layer.mergeAll(Describe.layer, Interpreter.layer(Titles)).pipe(
              Layer.provideMerge(
                Layer.mergeAll(
                  AgentAction.layerHost({
                    registry,
                    flows,
                    limits: { calls: 8 },
                    capabilityEnvelope: envelope,
                    maxFrames: 2
                  }),
                  SeatResolver.layer({
                    resolve: (id) =>
                      Effect.succeed(
                        Seat.make({
                          id,
                          model,
                          route: { prepare: () => Effect.succeed(prepared) },
                          contextWindowTokens: 200_000
                        })
                      )
                  }),
                  Agent.layer
                )
              ),
              Layer.provideMerge(Agent.layerDefaults),
              Layer.provideMerge(Action.layerImplementations),
              Layer.provideMerge(durableEngine(filename, "examples-mcp"))
            )
          )
        )
      )

    // The envelope names the grant this host decided on, not `*:*`.
    const envelope = [new Capability.CapabilityPattern({ action: "proc:spawn", resource: `mcp/${serverName}` })]
    const reading = yield* run([source], scripted(asked), envelope, "titles-1")

    // The same tools, still carrying the adapter's wildcard. A wildcard is a
    // pattern, and a declared capability is checked as an exact one, so the
    // widest envelope in the world does not admit it.
    const ungranted = yield* run(
      [projected],
      reporting(`mcp/${serverName}/word_count`),
      [new Capability.CapabilityPattern({ action: "*", resource: "*" })],
      "titles-ungranted"
    )

    return {
      reading,
      tools: client.tools.map((tool) => tool.name),
      flowNames: bindings.map((binding) => binding.descriptor.name),
      declaredCapabilities: [...new Set(declared.flatMap((binding) => binding.descriptor.capabilities))],
      disclosed: asked.every((text) => text.includes(`mcp/${serverName}/word_count`)),
      ungranted: ungranted.slug
    } satisfies Summary
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Effect.scoped,
    Effect.orDie
  )
