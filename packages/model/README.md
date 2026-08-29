# @smthrs/model

Schema-first Effect model protocols, routes, and streaming events for flows. It separates provider-neutral model requests from provider framing, authentication, endpoint selection, transport execution, and event normalization.

```sh
npm install @smthrs/model
```

## Public API

The root entry point exports these namespaces; each is also importable from `@smthrs/model/<Module>`.

| Module              | Public exports                                                                                                                                                                                                                                                                      | Description                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `AnthropicMessages` | `Body`, `protocol`                                                                                                                                                                                                                                                                  | Implements Anthropic Messages request encoding and stream decoding.               |
| `Auth`              | `credentialNamePattern`, `isCredentialName`, `Redacted`, `Auth`, `apiKeyHeader`, `bearer`                                                                                                                                                                                           | Models redacted authentication and constructs API-key or bearer headers.          |
| `CanonicalJson`     | `stringify`, `bytes`, `shortHash`                                                                                                                                                                                                                                                   | Produces canonical JSON text, bytes, and stable short hashes.                     |
| `DeferredTools`     | `ProtocolId`, `Resolution`, `supportsDeferred`, `resolve`                                                                                                                                                                                                                           | Resolves deferred-tool support for a provider protocol.                           |
| `Endpoint`          | `Endpoint`, `MakeOptions`, `make`, `render`                                                                                                                                                                                                                                         | Validates and renders model endpoint URLs.                                        |
| `Framing`           | `Framing`, `sse`                                                                                                                                                                                                                                                                    | Defines response framing and the server-sent-events implementation.               |
| `Model`             | `ModelFailure`, `Model`, `make`, `layer`, `makeNoop`, `layerNoop`                                                                                                                                                                                                                   | Defines the provider-neutral streaming Model service.                             |
| `ModelError`        | `ModelErrorCode`, `ModelError`                                                                                                                                                                                                                                                      | Defines typed configuration, routing, transport, protocol, and provider failures. |
| `ModelEvent`        | `settledMessage`, `Usage`, `TextStart`, `TextDelta`, `TextEnd`, `ThinkingStart`, `ThinkingDelta`, `ThinkingEnd`, `ToolCallStart`, `ToolCallDelta`, `ToolCallEnd`, `UsageEvent`, `Settle`, `ModelEvent`                                                                              | Defines normalized streaming events and settled-message projection.               |
| `ModelRequest`      | `JsonObject`, `StopReason`, `SystemPart`, `TextPart`, `ThinkingPart`, `ToolCallPart`, `ToolResultPart`, `ContentPart`, `AssistantContentPart`, `UserMessage`, `AssistantMessage`, `ToolMessage`, `Message`, `ToolDefinition`, `ReasoningEffort`, `GenerationParams`, `ModelRequest` | Supplies schemas and inferred types for provider-neutral requests.                |
| `OpenAIChatCompletions` | `ResponseFormat`, `StructuredOutput`, `Body`, `State`, `protocolWith`, `protocol`                                                                                                                                                                   | Implements OpenAI Chat Completions encoding, stream decoding, and the native-structured-output toggle. |
| `OpenAICompatible`  | `make`                                                                                                                                                                                                                                                                              | Builds routes for OpenAI-compatible chat protocols.                               |
| `OpenAIResponses`   | `Body`, `State`, `protocol`                                                                                                                                                                                                                                                         | Implements OpenAI Responses request encoding and stream decoding.                 |
| `Protocol`          | `Protocol`, `ProtocolBody`, `ProtocolStream`, `make`, `jsonEvent`                                                                                                                                                                                                                   | Defines and constructs provider protocol codecs.                                  |
| `RequestExecutor`   | `ErrorClassifier`, `ExecuteOptions`, `RequestError`, `RequestExecutor`, `make`, `layer`                                                                                                                                                                                             | Executes framed HTTP model requests through the kernel HTTP client.               |
| `Route`             | `PreparedRequest`, `Config`, `Route`, `prepare`, `make`, `toModel`, `layer`, `anthropic`, `openai`, `openaiCompatible`                                                                                                                                                                                  | Combines endpoint, auth, protocol, and transport into a Model layer.              |
| `ToolStream`        | `OpenToolCall`, `State`, `Completed`, `EndResult`, `FlushResult`, `initial`, `start`, `delta`, `end`, `flushAborted`                                                                                                                                                                | Reconstructs streamed tool calls and flushes incomplete calls.                    |

```ts
import { Model } from "@smthrs/model"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const model = yield* Model.Model
  return model
}).pipe(Effect.provide(Model.layerNoop()))
```

Use `Route.layer(config)` for a configured provider route or `Model.layer(implementation)` for a custom provider. `@smthrs/model/package.json` is also exported; `internal/*` and nested `*/index` subpaths are blocked.
