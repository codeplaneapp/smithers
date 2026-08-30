# @smthrs/errors

`SmithersError` and the error codes the Smithers integration adapters raise.

This is a private workspace package. It is not published to npm at
`1.0.0-rc.0`: `@smthrs/integrations` is its only consumer, and every other
package states its failures as `Schema.TaggedError` classes of its own.

## What it is for

An integration talks to somebody else's API, so its failures have to survive
being read by a human, matched by a caller, and written into a log that must
never contain a token. `SmithersError` gives all three:

- `code` classifies the failure (`INTEGRATION_ERROR`, `TELEGRAM_API_ERROR`, …).
- `summary` is the message without the appended documentation URL.
- `details` carries provider-safe context and never carries credentials.
- `docsUrl` points at the reference page for the code.

```ts
import { isSmithersError, SmithersError } from "@smthrs/errors"

const error = new SmithersError("INVALID_INPUT", "no bot token configured")
error.code // "INVALID_INPUT"
error.message // "no bot token configured See https://smithers.sh/reference/errors"
isSmithersError(error) // true
```

## Codes

`smithersErrorDefinitions` is the runtime source of truth. `SmithersErrorCode`
is derived from its keys, so adding a code and documenting it are one edit.
Smithers 0.x carried 180 codes for an engine that no longer exists; 1.0 keeps
the five the integration trees raise.

| Code                         | Raised when                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `INVALID_INPUT`              | An integration helper receives an argument it cannot use.                                   |
| `INTEGRATION_ERROR`          | A client, webhook source, or listener reconciliation fails. `details.reason` classifies it. |
| `TELEGRAM_API_ERROR`         | The Telegram Bot API answers `ok: false`, a non-JSON body, or a transport failure.          |
| `TELEGRAM_INIT_DATA_INVALID` | Mini App `initData` is empty, expired, or fails verification.                               |
| `UNSUPPORTED`                | The runtime lacks a primitive an integration needs, such as Web Crypto.                     |

## Commands

```sh
pnpm --filter @smthrs/errors test
pnpm --filter @smthrs/errors check
pnpm --filter @smthrs/errors lint
```
