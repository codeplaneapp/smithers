# Error codes

`@smthrs/errors` is a private workspace package with one class,
`SmithersError`, and the five codes the `@smthrs/integrations` trees raise. It
exists only for those adapters. Every other package in this workspace states
its failures as `Schema.TaggedError` classes of its own, which is the flows
convention, so no new code belongs here unless an integration adapter raises
it.

This page is the target of `ERROR_REFERENCE_URL`. Every `SmithersError`
message ends with `See https://smithers.sh/reference/errors`, so the page has
to document every code the table below lists.
`packages/errors/test/SmithersError.test.ts` asserts that it does.

## The codes

| Code | Raised when | `details` |
| --- | --- | --- |
| `INVALID_INPUT` | An integration helper receives an argument it cannot use: a missing bot token, an approval option key containing a colon, callback data over Telegram's 64-byte limit, or a non-https Mini App URL. | none |
| `INTEGRATION_ERROR` | An integration client, webhook source, or listener reconciliation fails. `reason` classifies the failure so a caller can map it to a transport status. | `{ reason, ...providerSafeDetails }` |
| `TELEGRAM_API_ERROR` | The Telegram Bot API answers a call with `ok: false`, a non-JSON body, or a transport failure. The bot token is redacted from the message and details. | `{ method, errorCode, description, retryAfterSeconds }` |
| `TELEGRAM_INIT_DATA_INVALID` | Telegram Mini App `initData` is empty, expired, missing its hash or signature, or fails HMAC or Ed25519 verification. | none |
| `UNSUPPORTED` | The runtime lacks a primitive an integration needs, such as Web Crypto or Ed25519 verification. | none |

`packages/errors/src/ErrorCode.ts` holds the same table as
`smithersErrorDefinitions`, and `SmithersErrorCode` is derived from its keys.
Adding a code there and documenting it here are one change.

## Reading a failure

Classify by `code`, never by matching message text.

```ts
import { isSmithersError } from "@smthrs/errors"

if (isSmithersError(error) && error.code === "TELEGRAM_API_ERROR") {
  // error.details.errorCode is Telegram's own numeric code
}
```

`SmithersError` carries four fields beyond `message`:

- `code`, the machine-readable classification above.
- `summary`, the message without the appended documentation URL. Use this when
  you render a failure somewhere the URL would be noise.
- `details`, provider-safe context. No constructor in `@smthrs/integrations`
  ever puts a token, an API key, or a webhook secret here.
- `docsUrl`, this page.

Pass `{ includeDocsUrl: false }` to leave the URL out of `message`.

## `IntegrationError` and `IntegrationFailure`

`@smthrs/integrations` subclasses `SmithersError` as `IntegrationError`, which
adds a `reason`. The reasons and their meanings are in
[`integrations`](integrations.md#errors).

A durable action cannot fail with a class, because the failure has to be
written to the journal and read back after a restart.
`Core.ActionFailure.IntegrationFailure` is the schema form: the same `reason`,
a message already safe to persist, and `retryable`. `fromIntegrationError` and
`toIntegrationError` convert between them.
