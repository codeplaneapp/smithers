---
title: "Reference"
description: "SmithersError and the error codes the integration adapters raise"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/errors/docs/reference.md"
---

`@smthrs/errors` is a private workspace package with one class,
`SmithersError`, and the five codes the `@smthrs/integrations` trees raise. It
exists only for those adapters. Every other package in this workspace states
its failures as `Schema.TaggedError` classes of its own, which is the flows
convention, so no new code belongs here unless an integration adapter raises
it.

This page is the target of `ERROR_REFERENCE_URL`. A `SmithersError` message
ends with `See https://smithers.sh/reference/errors` unless the caller passes
`{ includeDocsUrl: false }` or the summary is blank. Before appending it, the
class removes every trailing copy of the suffix, including copies followed or
separated by whitespace, so the suffix is never appended twice.

## The codes

<!-- dprint-ignore-start -->
<!-- generated:error-codes start -->
<!-- generated:error-codes end -->
<!-- dprint-ignore-end -->

The table above is generated from `smithersErrorDefinitions` in
`packages/errors/src/ErrorCode.ts` by
`packages/errors/scripts/docs.mjs`. `SmithersErrorCode` is derived from the
keys of `smithersErrorDefinitions`, so the set of codes is closed. Adding a
code means adding a row to `smithersErrorDefinitions` and regenerating this
page in the same change. The `//packages/errors:docsPages` target fails on
drift.

## Reading a failure

Classify by `code`, never by matching message text.

```ts
import { isSmithersError } from "@smthrs/errors"

if (isSmithersError(error) && error.code === "TELEGRAM_API_ERROR") {
  // error.details?.["errorCode"] is Telegram's own numeric code.
  // TelegramApiError exposes it typed as `errorCode: number | null`.
}
```

`SmithersError` carries five fields beyond `message`:

- `code`, the machine-readable classification above.
- `summary`, the message without the appended documentation URL. Use this when
  you render a failure somewhere the URL would be noise.
- `details`, caller-supplied context that the class does not redact. The
  `@smthrs/integrations` constructors uphold the obligation to remove tokens,
  API keys, and webhook secrets before attaching it. The top-level record is
  copied and frozen at construction, so adding, removing, or replacing a
  top-level key on the caller's object afterwards cannot change it. Nested
  values are shared by reference and are not deep-frozen, so a caller must not
  mutate a nested record it has attached.
- `cause`, stored verbatim and not redacted. The caller must redact provider
  text, such as a bot token inside a URL or an API key inside a provider
  message, before attaching it. For example,
  `packages/smithers/agent/integrations/src/telegram/TelegramClient.ts` exports
  `redactBotToken` and runs it over provider text before constructing the
  error.
- `docsUrl`, this page.

Pass `{ includeDocsUrl: false }` to leave the URL out of `message`.

## `IntegrationError` and `IntegrationFailure`

`@smthrs/integrations` subclasses `SmithersError` as `IntegrationError`, which
adds a `reason`. The reasons and their meanings are in
[`@smthrs/integrations`](https://integrations.smithers.sh/reference/api/#errors).

A durable action cannot fail with a class, because the failure has to be
written to the journal and read back after a restart.
`Core.ActionFailure.IntegrationFailure` is the schema form: the same `reason`,
a message already safe to persist, and `retryable`. `fromIntegrationError` and
`toIntegrationError` convert between them.

## Exports

<!-- dprint-ignore-start -->
<!-- generated:error-exports start -->
<!-- generated:error-exports end -->
<!-- dprint-ignore-end -->
