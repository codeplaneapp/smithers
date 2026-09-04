# @smthrs/errors

**Documentation:** https://errors.smithers.sh

`SmithersError` and the error codes the Smithers integration adapters raise.

This is a private workspace package. It is not published to npm at
`1.0.0-rc.0`: `@smthrs/integrations` is its only consumer, and every other
package states its failures as `Schema.TaggedError` classes of its own.

## What it is for

An integration talks to somebody else's API, so its failures have to remain
readable to a human, classifiable by a caller, and safe to write into a log.
`SmithersError` provides stable error fields and stores caller-supplied context
verbatim. It does not redact values. Integration constructors must remove
credentials before constructing it.

- `code` classifies the failure (`INTEGRATION_ERROR`, `TELEGRAM_API_ERROR`, …).
- `summary` is the message without the appended documentation URL.
- `details` carries caller-supplied context. The top-level record is copied and
  frozen at construction, so adding, removing, or replacing a top-level key on
  the caller's object afterwards cannot change it. Nested values are shared by
  reference and are not deep-frozen, so a caller must not mutate a nested
  record it has attached. Integration constructors must remove credentials
  before attaching the record.
- `cause` is stored verbatim and is not redacted. Callers must redact provider
  text, including bot tokens in URLs and API keys in messages, before attaching
  it. `packages/smithers/agent/integrations/src/telegram/TelegramClient.ts` exports
  `redactBotToken` and runs it over provider text before constructing the
  error.
- `docsUrl` points at the reference page for the code.

```ts
import { isSmithersError, SmithersError } from "@smthrs/errors"

const error = new SmithersError("INVALID_INPUT", "no bot token configured")
error.code // "INVALID_INPUT"
error.message // "no bot token configured See https://smithers.sh/docs/reference/errors"
isSmithersError(error) // true
```

## Codes

`smithersErrorDefinitions` is the runtime source of truth.
`SmithersErrorCode` is derived from its keys, so the set of codes is closed.
Adding a code means adding a row to `smithersErrorDefinitions` and regenerating
the reference page in the same change. Smithers 0.x carried 180 codes for an
engine that no longer exists; 1.0 keeps the five the integration trees raise.

<!-- generated:error-codes start -->

| Code                         | Raised when                                                                                                                                                                                         | `details`                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `INVALID_INPUT`              | An integration helper receives an argument it cannot use: a missing bot token, an approval option key containing a colon, callback data over Telegram's 64-byte limit, or a non-https Mini App URL. | `{ [field]: value }` on the signal-name failures, otherwise none |
| `INTEGRATION_ERROR`          | An integration client, webhook source, or listener reconciliation fails. `reason` classifies the failure so a caller can map it to a transport status.                                              | `{ reason, ...providerSafeDetails }`                             |
| `TELEGRAM_API_ERROR`         | The Telegram Bot API answers a call with `ok: false`, a non-JSON body, or a transport failure. The bot token is redacted from the message and details.                                              | `{ method, errorCode, description, retryAfterSeconds }`          |
| `TELEGRAM_INIT_DATA_INVALID` | Telegram Mini App `initData` is empty, expired, missing its hash or signature, or fails HMAC or Ed25519 verification.                                                                               | `{ authDate }` on the expiry failures, otherwise none            |
| `UNSUPPORTED`                | The runtime lacks a primitive an integration needs, such as Web Crypto or Ed25519 verification.                                                                                                     | none                                                             |

<!-- generated:error-codes end -->

## Commands

```sh
pnpm --filter @smthrs/errors test
pnpm --filter @smthrs/errors check
pnpm --filter @smthrs/errors lint
```
