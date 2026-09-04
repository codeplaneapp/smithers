---
title: "API reference"
description: "Schema-first Effect model protocols, routes, and streaming events for flows"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/model/docs/api.md"
---

Install it with `npm install @smthrs/model`.

A model call is one composition: a `Protocol` owns the wire shape of an API
family, an `Endpoint` owns where to send it, an `Auth` owns the credential, and
a `Framing` owns how bytes become frames. `Route` combines the four and
`Route.layer` provides the result as the `Model` service.

```typescript
import { Model, Route } from "@smthrs/model"
import { Effect, Redacted, Result, Stream } from "effect"

const route = Result.getOrThrow(Route.anthropic({ apiKey: Redacted.make(process.env["ANTHROPIC_API_KEY"] ?? "") }))

const events = Effect.gen(function*() {
  const model = yield* Model.Model
  return yield* Stream.runCollect(model.stream(request))
}).pipe(Effect.provide(Route.layer(route)))
```

## Built-in routes

| Constructor                       | Protocol                          | URL it builds                                     |
| --------------------------------- | --------------------------------- | ------------------------------------------------- |
| `Route.anthropic`                 | Anthropic Messages                | `https://api.anthropic.com/v1/messages`           |
| `Route.openai`                    | OpenAI Responses                  | `https://api.openai.com/v1/responses`             |
| `Route.openaiResponsesCompatible` | OpenAI Responses                  | `<origin>/v1/responses`                           |
| `Route.openaiChatCompatible`      | OpenAI Chat Completions           | `<origin>/v1/chat/completions`                    |
| `OpenAIChatGPT.make`              | OpenAI Responses, ChatGPT backend | `https://chatgpt.com/backend-api/codex/responses` |

Both compatible constructors take the provider origin and append the rest
themselves, so one origin cannot produce two different URLs. `Route.openaiCompatible`
and `OpenAICompatible.make` are the earlier spellings, kept working and
deprecated: they take a base that already includes `/v1` and a base that
excludes it respectively, which is exactly the confusion the two new names
remove.

Responses and Chat Completions are different wire shapes, not two names for
one. `api.openai.com` serves Responses. Ollama, Gemini's compatibility layer,
Cerebras, OpenRouter's chat route and most other self-hosted or third-party
"OpenAI-compatible" servers serve Chat Completions.

## Failure behaviour

Every failure is a `ModelError` whose `code` is the contract. Provider message
text is not a contract and changes without notice, so branch on `code`.

| Code                      | Meaning                                               | Retryable |
| ------------------------- | ----------------------------------------------------- | --------- |
| `invalid_request`         | The request is malformed for this provider.           | no        |
| `context_overflow`        | The request did not fit the model's context window.   | no        |
| `no_route`                | No model is configured.                               | no        |
| `authentication`          | The credential was rejected.                          | no        |
| `rate_limited`            | A transient limit.                                    | yes       |
| `quota_exceeded`          | The account has no usable balance or quota.           | no        |
| `content_policy`          | The provider refused on safety grounds.               | no        |
| `provider_internal`       | The provider failed on its own side.                  | yes       |
| `transport`               | The connection failed.                                | yes       |
| `call_timeout`            | The caller's own wall-clock budget expired.           | yes       |
| `invalid_provider_output` | The provider sent something the protocol cannot read. | no        |
| `unknown`                 | Unclassified.                                         | no        |

`quota_exceeded` is deliberately not retryable: waiting does not add credit, and
`@smthrs/agent` parks the seat durably on `retryAfterMillis` or
`resetAtEpochMillis` instead of burning attempts. An HTTP 402, a provider code
in the quota vocabulary, and Anthropic's HTTP 400 "credit balance is too low"
message all reach that code.

`path` is present when the failure is a request the package refused to send. It
names the offending member (`messages[2].content[0].text`) and never carries its
value, because a request member may hold a credential or user content.

### The retry ladder

`RequestExecutor` retries inside one call: at most two retries after the first
attempt, starting at 500 ms, doubling, jittered, capped at 10 s per wait and 60 s
in total. Only a retryable code is retried. A `Retry-After` or `retry-after-ms`
header replaces the computed wait and is bounded by the same 10 s per-wait cap;
a value larger than the whole 60 s budget is not slept at all, and the error
surfaces immediately with its reset metadata so the caller can park durably
instead of holding the process. Three consecutive `transport` failures replace
the HTTP client itself, because a destroyed connection pool is the failure
waiting does not repair.

A stream that ends without a `settle` event was interrupted.
`ModelEvent.settledMessage` folds it into an assistant message with stop reason
`aborted`, and every built-in lowering omits an aborted or errored turn from the
next request rather than replaying content the provider will reject. Partial
tool-call arguments on that interrupted turn are preserved verbatim for audit;
they are never rewritten to `{}` or treated as executable input.

### The ChatGPT route refuses maxTokens

`OpenAIChatGPT.make` targets the ChatGPT-subscription backend, which rejects
`max_output_tokens` outright and offers no other output cap, verified against
the live backend. A request that sets `params.maxTokens` therefore fails in
`Route.prepare` as `invalid_request` with `path: "params.maxTokens"`, before
signing and transport, rather than being sent without the budget the caller
asked for. Omit `maxTokens` on that route. Every other route sends it.

## Redaction and limits

Credentials never enter a `PreparedRequest`: it carries the endpoint, the public
headers, and the canonical body bytes that a sealed step keys on, and `Auth`
signs a copy of the headers as the request leaves. A route header whose name
looks like a credential is refused rather than published.

Diagnostics are scrubbed twice. Values the package knows to be credentials are
removed literally, in raw, URL-encoded and JSON-escaped form. A JSON error body
is additionally walked and every value under a credential-shaped key is replaced
at any depth. Numeric request fields such as `max_tokens` and `budget_tokens`
are not credentials and are left intact, so a provider diagnostic quoting them
stays readable.

A failed response body stops being read at 64 KiB, so nothing beyond that is
ever held, parsed, classified or redacted, and all three recursive walks over it
stop at depth 12: past that a redacted subtree is replaced whole rather than
descended. The text kept on the error is capped at 16 KiB, reachable as
`ModelError.body` with `ModelError.bodyTruncated` set when either cap bites.
Both live outside the error's schema and are non-enumerable, so a journal never
copies a provider body into run state. Endpoint URLs
must be `http` or `https`, must not embed credentials or fragments, must not
carry credential-shaped query keys, and must not contain relative path segments.

## Ownership and mutability

`ModelRequest` and its parts are plain immutable schema values. `Route.prepare`
validates the request once and every later step reads that snapshot, so mutating
the object a call was given while the call is in flight changes nothing about
what is sent. `PreparedRequest` is likewise a value: its `body` is a fresh
`Uint8Array` per preparation and callers must not mutate it.

`CanonicalJson.stringify` is stricter than `JSON.stringify` on purpose. A value
`JSON.stringify` would drop or reshape means the sealed-step key and the wire
body describe different requests, so it is rejected instead of encoded.
`@smthrs/canonical` mirrors `JSON.stringify` and is the right encoder
everywhere that is not a provider request body.
