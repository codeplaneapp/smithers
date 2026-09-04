---
title: "Quickstart"
description: "A guided first model call with @smthrs/model: stub stream, real Anthropic route, and the settled message fold."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/model/docs/quickstart.md"
---

This quickstart takes you from an empty file to a folded assistant message:
first against a stub model that runs anywhere, then against a real provider
route. You need Node.js 22.19.0 or later.

## 1. Install the package

```bash
pnpm add @smthrs/model
```

## 2. Run a stub model

Every consumer talks to the `Model` service: one method, `stream`, that takes
a `ModelRequest` and returns a stream of `ModelEvent` values. Provide a stub
implementation so the first run needs no credential:

```ts
import { Model, ModelEvent, ModelRequest } from "@smthrs/model"
import { Effect, Stream } from "effect"

const request = ModelRequest.ModelRequest.make({
  modelId: "test-model",
  system: [],
  messages: [ModelRequest.Message.user("Say hello.")],
  tools: [],
  params: ModelRequest.GenerationParams.make()
})

const stub = Model.layer({
  stream: () =>
    Stream.make(
      { type: "text-start", id: "text-0" } as const,
      { type: "text-delta", id: "text-0", text: "Hello" } as const,
      { type: "text-end", id: "text-0" } as const,
      { type: "settle", stopReason: "stop" } as const
    )
})

const program = Effect.gen(function*() {
  const model = yield* Model.Model
  const events = yield* Stream.runCollect(model.stream(request))
  return ModelEvent.settledMessage(events)
}).pipe(Effect.provide(stub))

Effect.runPromise(program).then((result) => console.log(result.message.content))
```

Run it and you should see one text part:

```text
[ { type: 'text', text: 'Hello' } ]
```

`settledMessage` folds the event stream back into the one durable assistant
message, plus the usage counters the stream reported. You will use it on real
streams exactly the same way.

## 3. Call a real provider

To send the same request to Anthropic, build a route from your API key and
provide it as the `Model` service. Set `ANTHROPIC_API_KEY` in your
environment first.

```ts
import { Model, ModelEvent, ModelRequest, RequestExecutor, Route } from "@smthrs/model"
import { Effect, Layer, Redacted, Result, Stream } from "effect"

const route = Result.getOrThrow(
  Route.anthropic({ apiKey: Redacted.make(process.env["ANTHROPIC_API_KEY"] ?? "") })
)

const request = ModelRequest.ModelRequest.make({
  modelId: "claude-sonnet-4-5",
  system: [],
  messages: [ModelRequest.Message.user("Say hello in one sentence.")],
  tools: [],
  params: ModelRequest.GenerationParams.make({ maxTokens: 256 })
})

const program = Effect.gen(function*() {
  const model = yield* Model.Model
  const events = yield* Stream.runCollect(model.stream(request))
  return ModelEvent.settledMessage(events)
})

const modelLayer = Route.layer(route).pipe(Layer.provide(RequestExecutor.layer))
```

`Route.layer(route)` builds the `Model` implementation from the route, and
`RequestExecutor.layer` supplies the bounded-retry executor it runs on. One
requirement remains on that layer: the kernel `HttpClient` service, which
checks a `model:call` capability per host and model. The Smithers runtime
provides it; [the kernel API](https://kernel.smithers.sh/reference/api/) documents the client and the
permission check.

With the layer fully provided, the same fold from step 2 answers the settled
message: its content parts, its `stopReason`, and the token usage Anthropic
reported.

## 4. Read the result

The folded message carries everything a transcript needs to continue:

```ts
const { message, usage } = result
for (const part of message.content) {
  if (part.type === "text") console.log(part.text)
}
console.log(message.stopReason, usage.totalTokens)
```

A `stopReason` of `"stop"` means the turn completed. `"aborted"` means the
stream ended without a `settle` event; the fold still returns the partial
content so the transcript stays resumable. [Read the stream](/guides/read-the-stream/)
covers every event and stop reason.

## Where to go next

- To use OpenAI, an OpenAI-compatible server, or the ChatGPT-subscription
  backend, see [Define a route](/guides/define-a-route/).
- To branch on typed failures, see [Handle failures](/guides/handle-failures/).
- For the design behind routes and sealed steps, see
  [Schema-first model calls](/concepts/schema-first/).
