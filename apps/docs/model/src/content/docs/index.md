---
title: "@smthrs/model"
description: "Schema-first Effect model protocols, routes, and streaming events for flows."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/model/docs/README.md"
---

`@smthrs/model` is the provider seam for Smithers flows. One service,
`Model`, takes a serializable `ModelRequest` and answers a stream of typed
`ModelEvent` values. Everything provider-specific sits behind that seam: the
wire protocol, the HTTP endpoint, the credential, the byte framing, the
transport, and the translation of provider errors into one vocabulary.

Use this package when a flow, harness, or test needs to call an LLM provider
without knowing which provider answers. `@smthrs/agent` composes it into the
durable model step; you can also drive it directly.

```bash
pnpm add @smthrs/model
```

## The smallest working program

`Model.layerNoop()` provides a `Model` that fails every call with a typed
`no_route` error, so this program runs anywhere without a credential:

```ts
import { Model, ModelRequest } from "@smthrs/model"
import { Effect, Stream } from "effect"

const request = ModelRequest.ModelRequest.make({
  modelId: "test-model",
  system: [],
  messages: [ModelRequest.Message.user("Hello")],
  tools: [],
  params: ModelRequest.GenerationParams.make()
})

const program = Effect.gen(function*() {
  const model = yield* Model.Model
  return yield* Stream.runDrain(model.stream(request))
}).pipe(Effect.provide(Model.layerNoop()))
```

For a configured provider, `Route.layer` provides the same service from an
API key:

```ts
import { Model, Route } from "@smthrs/model"
import { Effect, Redacted, Result, Stream } from "effect"

const route = Result.getOrThrow(
  Route.anthropic({ apiKey: Redacted.make(process.env["ANTHROPIC_API_KEY"] ?? "") })
)

const events = Effect.gen(function*() {
  const model = yield* Model.Model
  return yield* Stream.runCollect(model.stream(request))
}).pipe(Effect.provide(Route.layer(route)))
```

`Route.layer` needs the `RequestExecutor` service, which needs the kernel
HTTP client. The Smithers runtime provides both; for the full composition,
see the [quickstart](/quickstart/).

## Namespaces

The root entry point re-exports seventeen namespaces. Each is also importable
on its own subpath, such as `@smthrs/model/Route`.

| Namespace               | What it owns                                                         |
| ----------------------- | -------------------------------------------------------------------- |
| `Model`                 | The one provider seam: a request in, a stream of typed events out.   |
| `ModelRequest`          | The serializable, credential-free declaration of one model call.     |
| `ModelEvent`            | The normalized events one call emits, and the `settledMessage` fold. |
| `ModelError`            | The provider-neutral failure vocabulary.                             |
| `Route`                 | A resolved route: endpoint, protocol, framing, and credentials.      |
| `Protocol`              | The wire contract of a model API family.                             |
| `Endpoint`              | The credential-free HTTP target of a route, and its validation.      |
| `Auth`                  | Credential handling: redacted keys, signing, optional refresh.       |
| `Framing`               | Byte-stream framing: `sse` and `ndjson`.                             |
| `RequestExecutor`       | Bounded retries, quota classification, safe diagnostics.             |
| `AnthropicMessages`     | Anthropic Messages lowering and stream parsing.                      |
| `OpenAIResponses`       | OpenAI Responses lowering and stream parsing.                        |
| `OpenAIChatCompletions` | OpenAI Chat Completions lowering and stream parsing.                 |
| `OpenAIChatGPT`         | Route construction for the ChatGPT-subscription backend.             |
| `DeferredTools`         | Replay-safe policy for native deferred tool loading.                 |
| `ToolStream`            | Pure accumulation of fragmented tool-call arguments.                 |
| `CanonicalJson`         | Deterministic JSON encoding for model-step inputs.                   |

## Where to go next

- To install and import the package, see [installation](/installation/).
- For a guided first call end to end, see the [quickstart](/quickstart/).
- To point the package at your provider, see
  [Define a route](/guides/define-a-route/).
- To consume the event stream, see [Read the stream](/guides/read-the-stream/).
- To branch on failures, see [Handle failures](/guides/handle-failures/).
- For the mental models, see [Schema-first model calls](/concepts/schema-first/)
  and [Streaming](/concepts/streaming/).
- For every export and its behavior, see the [API reference](/reference/api/).
- For concrete failure modes and their fixes, see
  [troubleshooting](/troubleshooting/).
