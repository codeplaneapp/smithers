---
title: "Handle failures"
description: "Branch on ModelError codes: what the executor already retried, when to park, and when to give up."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/model/docs/guides/handle-failures.md"
---

Every provider failure reaches you as a `ModelError` whose `code` is the
contract. Provider message text is not a contract and changes without
notice, so branch on `code`, never on message wording. Kernel permission
failures arrive as their own classes (`PermissionRequired`,
`PermissionDenied`, `GrantStoreError` from `@smthrs/capability`), never as
`ModelError` codes.

## What already happened before you see the error

The `RequestExecutor` retried the request inside the call: at most two
retries after the first attempt, starting at 500 ms, doubling, jittered,
capped at 10 s per wait and 60 s in total, and only for a retryable code. A
provider wait that exceeds the 60 s budget is not slept at all. Three
consecutive `transport` failures replace the HTTP client itself. An
`authentication` failure is never retried, except once when the route's
`Auth` declares a `refresh`.

So the error in your hands has already had its transient chances. Your
decision is what to do next.

## Branch on the code

```ts
import { Model, ModelError } from "@smthrs/model"
import { Effect, Stream } from "effect"

const program = Effect.gen(function*() {
  const model = yield* Model.Model
  return yield* Stream.runCollect(model.stream(request))
}).pipe(
  Effect.catchIf(
    (error): error is ModelError => error instanceof ModelError,
    (error) => {
      switch (error.code) {
        case "quota_exceeded":
          return Effect.fail(error) // park until the account is funded
        case "context_overflow":
          return Effect.fail(error) // compact the transcript, then retry
        case "call_timeout":
          return Effect.fail(error) // re-issue with a tighter request
        default:
          return Effect.fail(error)
      }
    }
  )
)
```

The twelve codes and their retryability are tabulated in the
[API reference](/reference/api/#modelerror). The decision per code:

- `rate_limited`: transient. The executor already waited; a durable caller
  can park on `error.resetAtEpochMillis` instead of burning attempts.
- `quota_exceeded`: never retryable, because waiting does not add credit.
  Park until the account is funded; `retryAfterMillis`,
  `resetAtEpochMillis`, and `resetSource` carry the wake instant when the
  provider stated one. An HTTP 402, a provider code in the quota vocabulary,
  and Anthropic's "credit balance is too low" all arrive here.
- `context_overflow`: the request did not fit the window. Compact or
  truncate the transcript, then issue a new request.
- `call_timeout`: your own wall-clock budget expired and the caller
  interrupted the request, so nothing about its settlement is known.
  Re-issue with the model told to be shorter.
- `authentication`: the credential was rejected. Rotating it outside the
  route is the only repair; on a route whose `Auth` has a `refresh`, the one
  automatic retry already happened.
- `invalid_request`: the request is malformed for this provider. When the
  package refused to send it, `error.path` names the offending member, such
  as `params.maxTokens`, and never its value.
- `content_policy`: the provider refused on safety grounds. Retrying the
  same content reaches the same refusal.
- `provider_internal`, `transport`: the provider or the connection failed.
  The executor's ladder already applied; an outer, longer-horizon retry is
  the caller's policy.
- `invalid_provider_output`: the provider sent bytes the protocol cannot
  read. Report it; the request was fine.
- `no_route`: no model is configured in this environment. This is the noop
  layer answering; provide a route.
- `unknown`: unclassified. Inspect `httpStatus`, `providerCode`, and
  `requestId` when reporting it.

## Read the detail fields

Beyond `code`, a `ModelError` carries `message`, `path`, `retryAfterMillis`,
`resetAtEpochMillis`, `resetSource`, `providerCode`, `requestId`, and
`httpStatus`, all scrubbed of credentials. The failed provider response body
is available for diagnostics as `error.body`, redacted and capped at 16 KiB,
with `error.bodyTruncated` set when a cap bit. Both fields are
non-enumerable: they survive for logging, but serializing the error never
copies a provider body into run state.

## The structured-output refusal

A Chat Completions route configured with `structuredOutput` refuses a
request that declares tools, failing preparation as `invalid_request`,
because providers reject `tools` together with `response_format`. Drop the
tools, or drop `structuredOutput` and enforce the schema in the prompt. A
request with `toolChoice: "none"` is the one exception: its lowering omits
`tools`, so it passes.
