/**
 * Give a model-backed step real tools, and run the code it writes inside a
 * sandbox.
 *
 * Example 11 is one model call with no tools. This is the same shape with the
 * one thing a working agent adds: a catalog. There is no `ctx.fs`, no
 * `ctx.shell`, and no tool-call protocol. A capability is an ordinary flow
 * declaration plus the code that runs it, bound through
 * `@smthrs/harness/FlowBinding`, and the model reaches it the way it reaches
 * anything else: it finds it in `ctx.flows` and calls it with `ctx.call`.
 * `StandardFlows.filesystem` is that pairing for the seven standard file
 * capabilities, over whatever `FileSystem` the host provides. Here that is the
 * real Node one, pointed at a real directory.
 *
 * The model does not run the code either. It answers with a fenced `cell`
 * block, and the block is evaluated inside the QuickJS sandbox
 * `Agent.layerDefaults` supplies: a separate WebAssembly realm with an explicit
 * budget, no ambient host access, and exactly one way out, which is a call to a
 * declared flow. A cell that loops forever spends its budget and stops; a cell
 * that reaches for `require` finds nothing there.
 *
 * Three boundaries therefore stack in one step, and each is visible below:
 *
 * - the CAPABILITY envelope, which is the host's answer to "what may this run
 *   touch at all". The standard flows declare real capabilities, and an empty
 *   envelope refuses every one of them.
 * - the SANDBOX budget, which bounds the code the model wrote.
 * - the durable step boundary, which records each call as a keyed
 *   `cell-call-started`/`cell-call-settled` pair, so a re-driven step replays
 *   the calls instead of repeating them.
 *
 * The seat resolves to a scripted model, so the example runs in CI with no API
 * key. Point `SeatResolver` at a provider route and nothing above it changes.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import * as Capability from "@smthrs/capability/Capability"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Journal, type JournalEvent } from "@smthrs/journal"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import * as Registry from "@smthrs/registry/Registry"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { durableEngine } from "./durable-layer.ts"

/** What the step must answer with. Nothing downstream parses model text. */
export const Tally = Schema.Struct({
  totalLines: Schema.Number,
  wrotePath: Schema.String,
  bytesWritten: Schema.Number
})

/**
 * The step. Its prompt names the two paths, which is how a scripted model, and
 * a real one, learns which files this task is about.
 */
export const Summarize = AgentAction.make("examples/SandboxSummarize", {
  payload: { source: Schema.String, target: Schema.String },
  output: Tally,
  seat: "anthropic:claude-sonnet-4-5",
  system: ["You maintain a repository. Use the file tools rather than guessing at contents."],
  prompt: ({ source, target }) =>
    `Count the lines in the source file and write the count to the target file.\nSOURCE: ${source}\nTARGET: ${target}`
})

/** The flow that runs the one step whose cell reaches the file tools. */
export const Audit = Flow.make("examples/Audit", {
  payload: { source: Schema.String, target: Schema.String },
  success: Tally,
  error: AgentAction.AgentFailure,
  body: (payload: { readonly source: string; readonly target: string }) => Summarize.call(payload)
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
 * A scripted model that reads the two paths out of the request and answers with
 * one cell that uses the tools.
 *
 * The paths are not baked in: they arrive in the prompt at run time, exactly as
 * they would for a provider, and the cell the model writes closes over what it
 * read. That is what makes this a scripted MODEL rather than a scripted answer.
 */
export const scripted = (calls: Array<string>): Model.Model =>
  Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        const asked = [
          ...request.system.map((part) => part.text),
          ...request.messages.flatMap((message) =>
            message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          )
        ].join("\n")
        const source = /SOURCE: (.+)/.exec(asked)?.[1]?.trim() ?? ""
        const target = /TARGET: (.+)/.exec(asked)?.[1]?.trim() ?? ""
        calls.push(`${source} -> ${target}`)
        const cell = [
          `const page = await ctx.call("read", { path: ${JSON.stringify(source)} })`,
          `const written = await ctx.call("write", {`,
          `  path: ${JSON.stringify(target)},`,
          "  content: String(page.totalLines) + \"\\n\"",
          "})",
          "ctx.done({",
          "  totalLines: page.totalLines,",
          "  wrotePath: written.path,",
          "  bytesWritten: written.bytesWritten",
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

/** What one run of the step observed. */
export interface Summary {
  /** The schema-typed answer the step settled with. */
  readonly tally: typeof Tally.Type
  /** The file the cell wrote, read back off the real disk. */
  readonly written: string
  /** The prompts the model saw, as `source -> target`. */
  readonly asked: ReadonlyArray<string>
  /** The distinct events the run journalled. */
  readonly eventTypes: ReadonlyArray<string>
}

/**
 * Runs the step against a real directory.
 *
 * @param filename the SQLite file the durable engine runs on
 * @param root a directory the run may read and write
 */
export const main = (filename: string, root: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    const source = join(root, "notes.md")
    const target = join(root, "line-count.txt")
    yield* Effect.sync(() => {
      mkdirSync(root, { recursive: true })
      writeFileSync(source, "alpha\nbeta\ngamma")
    })

    // The host's filesystem, handed to the bindings as a context. A browser host
    // supplies a different one and the cell sees no difference.
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
    const asked: Array<string> = []

    const host = AgentAction.layerHost({
      // The catalog the model is shown, and the registry its calls resolve
      // against. It holds nothing of its own here: every capability comes from
      // the bound sources below.
      registry: Registry.makeNoop({
        list: () => Effect.succeed([]),
        visible: () => Effect.succeed([]),
        getOption: () => Effect.succeed(Option.none())
      }),
      flows: [StandardFlows.filesystem(services)],
      // The explicit sandbox budget every cell in this composition runs under.
      limits: { calls: 8 },
      // The standard flows declare real capabilities, so the run needs a real
      // envelope. An empty one refuses every declared capability by contract,
      // which is the safe default rather than an oversight.
      capabilityEnvelope: [new Capability.CapabilityPattern({ action: "*", resource: "*" })],
      maxFrames: 3
    })

    const seats = SeatResolver.layer({
      resolve: (id) =>
        Effect.succeed(
          Seat.make({
            id,
            model: scripted(asked),
            route: { prepare: () => Effect.succeed(prepared) },
            contextWindowTokens: 200_000
          })
        )
    })

    const stack = Layer.mergeAll(Summarize.layer, Interpreter.layer(Audit)).pipe(
      Layer.provideMerge(Layer.mergeAll(host, seats, Agent.layer)),
      // The QuickJS sandbox the cell's code runs in, and the steering source it
      // drains. Both are browser-safe defaults.
      Layer.provideMerge(Agent.layerDefaults),
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(durableEngine(filename, "examples-sandbox"))
    )

    const observed = yield* Effect.scoped(
      Effect.gen(function*() {
        const tally = yield* Audit.execute({ source, target }, { executionId: "audit-1" })
        const journal = yield* Journal.Journal
        yield* journal.flush
        const page = yield* journal.entries({ runId: "audit-1" as JournalEvent.RunId, limit: 500 })
        return { tally, eventTypes: [...new Set(page.entries.map((entry) => entry.eventType))] }
      }).pipe(Effect.provide(stack))
    )

    return {
      tally: observed.tally,
      written: readFileSync(target, "utf8"),
      asked,
      eventTypes: observed.eventTypes
    } satisfies Summary
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeFileSystem.layer, Path.layer, NodeCrypto.layer)),
    Effect.orDie
  )
