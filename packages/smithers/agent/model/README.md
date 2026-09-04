# @smthrs/model

This package declares `effect` as an exact
`4.0.0-rc.108` peer dependency. Keep the application on that version so
all Smithers packages share one Effect runtime.

**Documentation:** https://model.smithers.sh

Schema-first Effect model protocols, routes, and streaming events for flows. It separates provider-neutral model requests from provider framing, authentication, endpoint selection, transport execution, and event normalization.

```sh
npm install @smthrs/model
```

Full documentation, including the failure vocabulary, retry ladder, redaction
rules, and resource limits, is in [`docs/reference.md`](./docs/reference.md)
and on the [documentation site](../../../../docs/pages/api/model.md). Both are
generated from `docs/api.md` and the JSDoc under `src/`.

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/model/<Namespace>`. The list below is generated from the barrel by `node packages/smithers/agent/model/scripts/docs.mjs`.

<!-- generated:model-exports start -->

- **`AnthropicMessages`**: Anthropic Messages request lowering and streaming event parsing.
  `Body`, `protocol`
- **`Auth`**: Credential handling for a model route: which field names carry secrets, and how a redacted credential is resolved at request time without ever entering the request's canonical, sealed form.
  `credentialNamePattern`, `isCredentialName`, `Redacted`, `Auth`, `apiKeyHeader`, `bearer`
- **`CanonicalJson`**: Deterministic JSON encoding for model-step inputs.
  `stringify`, `bytes`, `shortHash`
- **`DeferredTools`**: Replay-safe policy for native deferred provider tool loading.
  `ProtocolId`, `Resolution`, `supportsDeferred`, `resolve`
- **`Endpoint`**: The credential-free HTTP target of a model route, and its validation.
  `Endpoint`, `MakeOptions`, `make`, `render`
- **`Framing`**: Byte-stream framing, chosen independently of the protocol that interprets the frames.
  `Framing`, `sse`, `ndjson`
- **`Model`**: The one provider seam: a request in, a stream of typed events out.
  `ModelFailure`, `Model`, `make`, `layer`, `makeNoop`, `layerNoop`
- **`ModelError`**: The provider-neutral failure vocabulary, and the refinements that recognize a context overflow and an exhausted account in a provider's own wording.
  `ModelErrorCode`, `isContextOverflow`, `isQuotaExhausted`, `ModelError`
- **`ModelEvent`**: The normalized events one model call emits, and the fold that turns them back into a single durable assistant message.
  `Usage`, `TextStart`, `TextDelta`, `TextEnd`, `ThinkingStart`, `ThinkingDelta`, `ThinkingEnd`, `ToolCallStart`, `ToolCallDelta`, `ToolCallEnd`, `ToolResult`, `UsageEvent`, `Retry`, `Settle`, `ModelEvent`, `settledMessage`
- **`ModelRequest`**: The serializable, credential-free declaration of one model call.
  `JsonObject`, `StopReason`, `SystemPart`, `TextPart`, `ThinkingPart`, `ToolCallPart`, `ToolResultPart`, `ContentPart`, `AssistantContentPart`, `UserMessage`, `AssistantMessage`, `ToolMessage`, `Message`, `ToolDefinition`, `ReasoningEffort`, `GenerationParams`, `ToolChoice`, `ModelRequest`
- **`OpenAIChatCompletions`**: OpenAI Chat Completions request lowering and SSE event handling.
  `ResponseFormat`, `StructuredOutput`, `Body`, `State`, `protocolWith`, `protocol`
- **`OpenAIChatGPT`**: Route construction for OpenAI's ChatGPT-subscription Responses backend, the deployment the codex CLI speaks.
  `defaultBaseUrl`, `clientHeaders`, `make`
- **`OpenAIResponses`**: OpenAI Responses request lowering and SSE event handling.
  `Body`, `ChatGPTBody`, `State`, `protocol`, `chatgptProtocol`
- **`Protocol`**: The wire contract of a model API family, split from the deployment that serves it.
  `Protocol`, `ProtocolBody`, `ProtocolStream`, `make`, `jsonEvent`
- **`RequestExecutor`**: Executes provider requests with bounded retries, quota classification, and credential-safe diagnostics.
  `ErrorClassifier`, `ExecuteOptions`, `RequestError`, `rebuildAfter`, `Transport`, `fixed`, `RequestExecutor`, `makeWith`, `make`, `layer`
- **`Route`**: A resolved model route: an endpoint, a protocol, a framing, and the credentials to authorize with.
  `PreparedRequest`, `Config`, `Route`, `prepare`, `make`, `toModel`, `layer`, `anthropic`, `openai`, `openaiResponsesCompatible`, `openaiChatCompatible`
- **`ToolStream`**: Pure accumulation of fragmented provider tool-call arguments.
  `OpenToolCall`, `State`, `Completed`, `EndResult`, `FlushResult`, `initial`, `start`, `delta`, `end`, `flushAborted`

<!-- generated:model-exports end -->

```ts
import { Model } from "@smthrs/model"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const model = yield* Model.Model
  return model
}).pipe(Effect.provide(Model.layerNoop()))
```

Use `Route.layer(config)` for a configured provider route or `Model.layer(implementation)` for a custom provider. `@smthrs/model/package.json` is also exported; `internal/*` and nested `*/index` subpaths are blocked.
