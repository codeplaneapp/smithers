/**
 * Run one routed flow against a recorded model fixture.
 *
 * ```ts
 * cachedModelTest("chat answers a balance question", {
 *   fixture: new URL("./fixtures/balance.json", import.meta.url),
 *   flow: "chat",
 *   payload: { message: "What is vitalik.eth's balance?" },
 *   expect: (output) => { expect(output.answer).toContain("ETH") }
 * })
 * ```
 *
 * Two modes, one call site. Replay is the default: the fixture is decoded with
 * `@smthrs/testing`'s `Fixture` schema and served by `RecordedModel`, with no
 * network and no API key. Recording (`SMTHRS_RECORD=1`) builds the live model
 * from `options.live`, captures every request and event through
 * {@link recordModel}, and rewrites the fixture after the run.
 *
 * `vitest` is an optional peer: only this module needs it.
 *
 * @since 0.1.0
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Interpreter } from "@smthrs/flow"
import { make as makeModel, type Model } from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import type * as Route from "@smthrs/model/Route"
import { Fixture, type RecordedCall } from "@smthrs/testing/Fixture"
import type { ModelEventLike, ModelRequestLike } from "@smthrs/testing/ModelLike"
import * as RecordedModel from "@smthrs/testing/RecordedModel"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { expect as vitestExpect, test } from "vitest"
import { type AgentSpec, type AnyFlowSpec, type AppDirs, defaultDirs, type SandboxSpec, type ToolsSpec } from "./app.ts"
import { discover } from "./router.ts"
import { layerFor, materializeFlow } from "./runtime.ts"

/**
 * One routed flow: its declaration plus the three layers resolved for it.
 *
 * @category models
 * @since 0.1.0
 */
export interface RoutedFlow {
  readonly id: string
  readonly file: string
  readonly spec: AnyFlowSpec
  readonly agent: AgentSpec
  readonly sandbox: SandboxSpec
  readonly tools: ToolsSpec
}

/**
 * What one {@link cachedModelTest} takes.
 *
 * @category models
 * @since 0.1.0
 */
export interface CachedModelTestOptions<P, O> {
  readonly fixture: URL
  readonly flow: string
  readonly payload: P
  readonly expect: (output: O) => void | Promise<void>
  /**
   * Builds the live model used when `SMTHRS_RECORD=1`. Omit it on a flow that
   * is only ever replayed; recording then fails with a message instead of
   * running silently against a noop model.
   */
  readonly live?: () => Model
  /**
   * Loads the routed flows this test may run. Defaults to re-running the
   * router over `process.cwd()` and importing just the named flow and its
   * three layer files.
   */
  readonly routes?: () => Promise<ReadonlyArray<RoutedFlow>>
  /** Source directories, when the app under test does not use the defaults. */
  readonly dirs?: AppDirs
  /** App root the default `routes` loader walks. Defaults to `process.cwd()`. */
  readonly root?: string
}

/**
 * Whether this process is recording rather than replaying.
 *
 * @category constructors
 * @since 0.1.0
 */
export const recording = (): boolean => process.env["SMTHRS_RECORD"] === "1"

/**
 * The credential-free route every test seat resolves to.
 *
 * A replayed run never reaches the network, and a recording run signs its own
 * request downstream of this value, so the body is a placeholder in both modes.
 *
 * @category models
 * @since 0.1.0
 */
export const preparedRequest: Route.PreparedRequest = {
  routeId: "cached-model-test",
  protocolId: "cached-model-test",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

type MessageLike = ModelRequestLike["messages"][number]
type AssistantPartLike = Extract<MessageLike, { readonly role: "assistant" }>["content"][number]

/** Projects one live message onto the structural shape a fixture stores. */
const toMessageLike = (message: ModelRequest.Message): MessageLike => {
  if (message.role === "user") {
    return { role: "user", content: message.content.map((part) => ({ type: "text", text: part.text })) }
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      content: message.content.map((part) => ({
        type: "tool-result",
        toolCallId: part.toolCallId,
        content: part.content,
        addedToolNames: [...part.addedToolNames]
      }))
    }
  }
  // An assistant message carries text, thinking, or a tool call; a tool result
  // is its own message, so there is no fourth case to fall through to.
  const content = message.content.map((part): AssistantPartLike =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : part.type === "thinking"
      ? { type: "thinking", text: part.text, signature: part.signature }
      : { type: "tool-call", id: part.id, name: part.name, arguments: part.arguments }
  )
  return {
    role: "assistant",
    content,
    stopReason: message.stopReason,
    responseId: message.responseId,
    itemIds: message.itemIds
  }
}

/**
 * Projects a live `ModelRequest` onto the structural shape a fixture stores.
 *
 * `toolChoice` is carried rather than dropped. `@smthrs/testing`'s request
 * schema holds it, and its replay digest reads it, so two requests that differ
 * only in `toolChoice` are different calls. Dropping it here would record a
 * request that the digest of the live request no longer matches, and the replay
 * would report the recorded call as unscripted. The key is omitted when the
 * request carries no choice, which is the shape the fixture schema declares.
 */
const toRequestLike = (request: ModelRequest.ModelRequest): ModelRequestLike => ({
  modelId: request.modelId,
  system: request.system.map((part) => ({ type: "text" as const, text: part.text })),
  messages: request.messages.map(toMessageLike),
  tools: request.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    deferred: tool.deferred,
    loader: tool.loader
  })),
  params: {
    maxTokens: request.params.maxTokens,
    temperature: request.params.temperature,
    topP: request.params.topP,
    topK: request.params.topK,
    stopSequences: request.params.stopSequences,
    thinkingBudget: request.params.thinkingBudget,
    reasoningEffort: request.params.reasoningEffort
  },
  ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice })
})

/**
 * Wraps a live model so every request and its events are appended to `sink`.
 *
 * The sink fires once per request, when its stream ends. A failed or
 * interrupted stream records the events seen so far, which is what makes a
 * half-recorded fixture visible instead of empty.
 *
 * Every event is recorded. `@smthrs/testing`'s `ModelEventLike` covers each
 * member of `@smthrs/model`'s event union, `tool-result` and `retry` included,
 * so nothing has to be dropped. Dropping either would replay a different stream
 * than the provider produced, and the tool output a harness reported is what
 * feeds the next request's tool message.
 *
 * @category constructors
 * @since 0.1.0
 */
export const recordModel = (live: Model, sink: (call: RecordedCall) => void): Model =>
  makeModel({
    stream: (request) =>
      Stream.suspend(() => {
        const events: Array<ModelEventLike> = []
        const flush = Effect.sync(() => {
          sink({ request: toRequestLike(request), model: request.modelId, events: [...events] })
        })
        return live.stream(request).pipe(
          Stream.tap((event) => Effect.sync(() => events.push(event))),
          Stream.ensuring(flush)
        )
      })
  })

/**
 * Adapts a replay `ModelLike` to the production `Model` seam.
 *
 * What arrives on the error channel is the provider failure a fixture recorded,
 * as `ModelLikeError`. That type is structural rather than `ModelError`, so it
 * is narrowed here to `invalid_provider_output`; no member of it declares a
 * `message` field, so the stable code is what identifies the failure.
 *
 * `UnscriptedModelError` and `ReplayHarnessMismatchError` do not come through
 * here. `@smthrs/testing` dies on both, because a fixture that does not
 * describe the run is a defect in the test rather than an outcome the code
 * under test can handle.
 */
const asModel = (replay: RecordedModel.Replay): Model =>
  makeModel({
    stream: (request) =>
      replay.model.stream(request).pipe(
        Stream.mapError((error) =>
          new ModelError({
            code: "invalid_provider_output",
            message: `recorded model replay failed: ${error.code}`
          })
        ),
        Stream.map((event): ModelEvent.ModelEvent => event)
      )
  })

const importModule = (root: string, file: string): Promise<Record<string, unknown>> =>
  import(/* @vite-ignore */ pathToFileURL(resolve(root, file)).href) as Promise<Record<string, unknown>>

const named = <T>(module_: Record<string, unknown>, name: string, file: string): T => {
  const value = module_[name]
  if (value === undefined) throw new Error(`${file} must export \`${name}\``)
  return value as T
}

/**
 * Resolves one flow by re-running the router, then imports only that flow and
 * its three layer files.
 *
 * `routes.gen.ts` is deliberately not used. It statically imports every page
 * and the shell layout so the Worker bundle sees them, and those pull in React
 * and `virtual:smthrs-app/manifest`, which exists only while the Vite plugin is
 * running. A model test has no business loading the UI graph.
 */
const discoverRoutedFlow = async (id: string, root: string, dirs: AppDirs): Promise<ReadonlyArray<RoutedFlow>> => {
  const routes = discover({ root, dirs })
  const route = routes.flows.find((candidate) => candidate.id === id)
  if (route === undefined) {
    throw new Error(
      `flow "${id}" is not routed. Known flows: ${routes.flows.map((candidate) => candidate.id).join(", ")}`
    )
  }
  if (route.file.endsWith(".mdx")) {
    throw new Error(`cachedModelTest cannot run ${route.file}: a markdown flow has no loader yet`)
  }
  const [flowModule, agentModule, sandboxModule, toolsModule] = await Promise.all([
    importModule(root, route.file),
    importModule(root, route.agent),
    importModule(root, route.sandbox),
    importModule(root, route.tools)
  ])
  return [{
    id: route.id,
    file: route.file,
    spec: named<AnyFlowSpec>(flowModule, "Flow", route.file),
    agent: named<AgentSpec>(agentModule, "Agent", route.agent),
    sandbox: named<SandboxSpec>(sandboxModule, "Sandbox", route.sandbox),
    tools: named<ToolsSpec>(toolsModule, "Tools", route.tools)
  }]
}

const readFixture = (path: string): Effect.Effect<typeof Fixture.Type, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(Fixture)(JSON.parse(readFileSync(path, "utf8")))

const writeFixture = (path: string, calls: ReadonlyArray<RecordedCall>): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ calls }, null, 2)}\n`)
}

/**
 * Runs one routed flow on a cached model, without registering a test.
 *
 * This is the body {@link cachedModelTest} puts inside `test()`. It is exported
 * so a harness other than vitest — or a test of this module itself — can drive
 * the same path and observe its refusals directly.
 *
 * @category constructors
 * @since 0.1.0
 */
export const runCachedModelTest = async <P, O>(
  name: string,
  options: CachedModelTestOptions<P, O>
): Promise<void> => {
  const fixturePath = fileURLToPath(options.fixture)
  if (!existsSync(fixturePath) && !recording()) {
    throw new Error(
      `no fixture at ${fixturePath}. Record one with \`pnpm test:record\` (SMTHRS_RECORD=1), then commit it.`
    )
  }

  const dirs = options.dirs ?? defaultDirs
  const root = options.root ?? process.cwd()
  const routed = await (options.routes ?? (() => discoverRoutedFlow(options.flow, root, dirs)))()
  const flow = routed.find((candidate) => candidate.id === options.flow)
  if (flow === undefined) {
    throw new Error(
      `flow "${options.flow}" is not routed. Known flows: ${routed.map((candidate) => candidate.id).join(", ")}`
    )
  }

  const calls: Array<RecordedCall> = []
  let model: Model
  if (recording()) {
    const live = options.live?.()
    if (live === undefined) {
      throw new Error(
        `SMTHRS_RECORD=1 needs a live model: add \`live: () => ...\` to cachedModelTest(${JSON.stringify(name)}).`
      )
    }
    model = recordModel(live, (call) => calls.push(call))
  } else {
    const fixture = await Effect.runPromise(readFixture(fixturePath))
    model = asModel(await Effect.runPromise(RecordedModel.make(fixture)))
  }

  const materialized = materializeFlow(flow.id, flow.spec, flow.agent)
  const host = layerFor({
    agent: flow.agent,
    sandbox: flow.sandbox,
    tools: flow.tools,
    seats: { resolve: () => Effect.succeed({ model, route: { prepare: () => Effect.succeed(preparedRequest) } }) },
    crypto: NodeCrypto.layer
  })
  const runtime = Layer.mergeAll(materialized.action.layer, Interpreter.layer(materialized.flow)).pipe(
    Layer.provideMerge(host)
  )

  try {
    // `materializeFlow` erases the flow's payload and success schemas, so the
    // call site restates them. `execute` reads `this.payloadSchema`, so it stays
    // bound to its flow.
    const execute = materialized.flow.execute.bind(materialized.flow) as (
      payload: unknown,
      options: { readonly executionId: string }
    ) => Effect.Effect<O, unknown, never>
    const output = await Effect.runPromise(
      execute(options.payload, { executionId: `e2e/${flow.id}/${name}` }).pipe(
        Effect.orDie,
        Effect.provide(runtime as unknown as Layer.Layer<never>)
      )
    )
    await options.expect(output)
  } finally {
    if (recording()) writeFixture(fixturePath, calls)
  }

  if (recording()) {
    vitestExpect(calls.length, "recording produced no model calls").toBeGreaterThan(0)
  }
}

/**
 * Registers one vitest test that runs a routed flow on a cached model.
 *
 * @category constructors
 * @since 0.1.0
 */
export const cachedModelTest = <P, O>(name: string, options: CachedModelTestOptions<P, O>): void => {
  test(name, () => runCachedModelTest(name, options))
}
