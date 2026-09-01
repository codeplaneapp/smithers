# @smthrs/model

Schema-first Effect model protocols, routes, and streaming events for flows. It separates provider-neutral model requests from provider framing, authentication, endpoint selection, transport execution, and event normalization.

```sh
npm install @smthrs/model
```

Full documentation, including the failure vocabulary, the retry ladder, the redaction rules and the resource limits, is in [`docs/reference.md`](./docs/reference.md). It is generated from this package: the prose lives in `docs/api.md`, the reference lives in the JSDoc under `src/`. It becomes `/api/model` on the site once `vocs.config.ts` lists that page in its sidebar; `Package.ts` records the blocker.

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/model/<Namespace>`. The table below is generated from the barrel by `node packages/model/scripts/docs.mjs`.

<!-- generated:model-exports start -->

| Namespace | Public exports | Description |
| --- | --- | --- |
| `AnthropicMessages` | `Body`, `protocol` | Anthropic Messages request lowering and streaming event parsing. |
| `Auth` | `credentialNamePattern`, `isCredentialName`, `Redacted`, `Auth`, `apiKeyHeader`, `bearer` | Credential handling for a model route: which field names carry secrets, and how a redacted credential is resolved at request time without ever entering the request's canonical, sealed form. |
| `CanonicalJson` | `stringify`, `bytes`, `shortHash` | Deterministic JSON encoding for model-step inputs. |
| `DeferredTools` | `ProtocolId`, `Resolution`, `supportsDeferred`, `resolve` | Replay-safe policy for native deferred provider tool loading. |
| `Endpoint` | `Endpoint`, `MakeOptions`, `make`, `render` | The credential-free HTTP target of a model route, and its validation. |
| `Framing` | `Framing`, `sse`, `ndjson` | Byte-stream framing, chosen independently of the protocol that interprets the frames. |
| `Model` | `ModelFailure`, `Model`, `make`, `layer`, `makeNoop`, `layerNoop` |  |
| `ModelError` | `ModelErrorCode`, `isContextOverflow`, `isQuotaExhausted`, `ModelError` |  |
| `ModelEvent` | `Usage`, `TextStart`, `TextDelta`, `TextEnd`, `ThinkingStart`, `ThinkingDelta`, `ThinkingEnd`, `ToolCallStart`, `ToolCallDelta`, `ToolCallEnd`, `ToolResult`, `UsageEvent`, `Retry`, `Settle`, `ModelEvent`, `settledMessage` |  |
| `ModelRequest` | `JsonObject`, `StopReason`, `SystemPart`, `TextPart`, `ThinkingPart`, `ToolCallPart`, `ToolResultPart`, `ContentPart`, `AssistantContentPart`, `UserMessage`, `AssistantMessage`, `ToolMessage`, `Message`, `ToolDefinition`, `ReasoningEffort`, `GenerationParams`, `ToolChoice`, `ModelRequest` |  |
| `OpenAIChatCompletions` | `ResponseFormat`, `StructuredOutput`, `Body`, `State`, `protocolWith`, `protocol` | OpenAI Chat Completions request lowering and SSE event handling. |
| `OpenAIChatGPT` | `defaultBaseUrl`, `clientHeaders`, `make` | Route construction for OpenAI's ChatGPT-subscription Responses backend, the deployment the codex CLI speaks. |
| `OpenAICompatible` | `make` | Route construction for providers that serve the OpenAI Responses API without its native extensions. |
| `OpenAIResponses` | `Body`, `ChatGPTBody`, `State`, `protocol`, `chatgptProtocol` | OpenAI Responses request lowering and SSE event handling. |
| `Protocol` | `Protocol`, `ProtocolBody`, `ProtocolStream`, `make`, `jsonEvent` | The wire contract of a model API family, split from the deployment that serves it. |
| `RequestExecutor` | `ErrorClassifier`, `ExecuteOptions`, `RequestError`, `rebuildAfter`, `Transport`, `fixed`, `RequestExecutor`, `makeWith`, `make`, `layer` | Executes provider requests with bounded retries, quota classification, and credential-safe diagnostics. |
| `Route` | `PreparedRequest`, `Config`, `Route`, `prepare`, `make`, `toModel`, `layer`, `anthropic`, `openai`, `openaiCompatible` | A resolved model route: an endpoint, a protocol, a framing, and the credentials to authorize with. |
| `ToolStream` | `OpenToolCall`, `State`, `Completed`, `EndResult`, `FlushResult`, `initial`, `start`, `delta`, `end`, `flushAborted` | Pure accumulation of fragmented provider tool-call arguments. |

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
