/**
 * A live smoke test of `packages/model` itself: `Route` → `Model.stream`,
 * with no `AgentAction`/`Interpreter` cell-REPL convention layered on top.
 *
 * `12`-`14` proved this same routing/protocol code is correct by driving it
 * through the full production agent harness, which wraps every call in a
 * sophisticated structured-completion convention meant for capable models
 * (GPT-4/Claude/Gemini-class). That convention is real production code,
 * working as designed — it is simply the wrong bar for a model small enough
 * to run for free on a nearly-full local disk. What this session actually
 * built and fixed lives in `packages/model` (the Chat Completions protocol,
 * the route constructors, the harness's cause-field serialization), and
 * that is exactly what this file proves, directly, with nothing else in
 * the way.
 *
 * @since 0.1.0
 */
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as KernelHttpClient from "@smthrs/kernel/HttpClient"
import { Message, ModelRequest } from "@smthrs/model/ModelRequest"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Route from "@smthrs/model/Route"
import { Effect, Layer, Redacted, Stream } from "effect"

/**
 * The real HTTP transport: the kernel's guarded client (always-allow, since
 * this is a standalone smoke test with no grant policy to enforce) over
 * Node's real undici-backed client.
 *
 * @category layers
 * @since 0.1.0
 */
export const executorLayer = RequestExecutor.layer.pipe(
  Layer.provide(KernelHttpClient.layer),
  Layer.provide(GrantStore.layerNoop),
  Layer.provide(NodeHttpClient.layerUndici)
)

/**
 * Sends one prompt to a real `openaiCompatible` endpoint and returns the
 * concatenated text of the response, with nothing but `packages/model`
 * between the caller and the wire.
 *
 * @category constructors
 * @since 0.1.0
 */
export const ask = (question: string, modelId: string, baseUrl: string, apiKey: string) =>
  Effect.gen(function*() {
    const routeConfig = yield* Effect.fromResult(Route.openaiCompatible({ id: "smoke", baseUrl, apiKey: Redacted.make(apiKey) }))
    const model = yield* Route.toModel(routeConfig)
    const request = ModelRequest.make({
      modelId,
      system: [],
      messages: [Message.user(question)],
      tools: [],
      params: {}
    })
    const chunks: Array<string> = []
    yield* model.stream(request).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event.type === "text-delta") chunks.push(event.text)
        })
      )
    )
    return chunks.join("")
  }).pipe(Effect.provide(executorLayer))

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , modelId = "qwen2.5-coder:1.5b", baseUrl = "http://localhost:11434/v1", apiKey = "local"] = process.argv
  Effect.runPromise(ask("What is the capital of France? Answer in one word.", modelId, baseUrl, apiKey)).then(
    (answer) => {
      console.log("ANSWER:", answer)
    },
    (error) => {
      console.error("FAILED:", error)
      process.exitCode = 1
    }
  )
}
