---
title: "@smthrs/errors"
description: "SmithersError and the five error codes the Smithers integration adapters raise: one class, a closed code vocabulary, and refinements that survive a duplicate copy of the package."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/errors/docs/README.md"
---

`@smthrs/errors` is one error class, `SmithersError`, and the closed set of
five codes that the Smithers integration adapters raise.

An integration talks to somebody else's API, so its failures cross three
boundaries at once. A person reads the message, a caller branches on the
classification, and an operator finds the whole thing in a log. `SmithersError`
gives those three readers stable fields: a machine-readable `code`, a `summary`
free of decoration, and a `details` record the class copies and freezes at
construction.

## The smallest example

```ts
import { isSmithersError, SmithersError } from "@smthrs/errors"

const error = new SmithersError("INVALID_INPUT", "no bot token configured")

error.code // "INVALID_INPUT"
error.summary // "no bot token configured"
error.message // "no bot token configured See https://smithers.sh/docs/reference/errors"
isSmithersError(error) // true
```

Every field is readonly, `code` is one of five string literals, and the
documentation URL is appended once no matter how many times the summary
already ends with it.

## The five codes

| Code                         | Raised when                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `INVALID_INPUT`              | An integration helper receives an argument it cannot use.                                      |
| `INTEGRATION_ERROR`          | An integration client, webhook source, or listener reconciliation fails.                       |
| `TELEGRAM_API_ERROR`         | The Telegram Bot API answers a call with `ok: false`, a non-JSON body, or a transport failure. |
| `TELEGRAM_INIT_DATA_INVALID` | Telegram Mini App `initData` fails parsing, freshness, or signature verification.              |
| `UNSUPPORTED`                | The runtime lacks a primitive an integration needs.                                            |

For the raise site, the `details` shape, and the fix for each code, read the
[Error code reference](/reference/error-codes/).

## What the class does not do

`SmithersError` stores `details` and `cause` verbatim. It never redacts,
truncates, or inspects them. The adapter that constructs the error owns that
obligation, and
[`@smthrs/integrations`](https://integrations.smithers.sh/reference/api/) upholds it: the Telegram client
runs `redactBotToken` over every string of provider text before it reaches a
constructor. For the full contract, read
[The shape of a SmithersError](/concepts/error-shape/).

`SmithersError` is also not a registry for the rest of the workspace. Every
other Smithers package states its failures as `Schema.TaggedError` classes of
its own, so a new code belongs here only when an integration adapter raises it.
[The closed code vocabulary](/concepts/error-codes/) explains why.

## Where to go next

- [Installation](/installation/): the workspace dependency and the import
  forms.
- [Quickstart](/quickstart/): raise, catch, and classify one failure end to
  end.
- [Handle a failed integration call](/guides/handle-a-failure/): the caller's
  side, including what to log.
- [Raise a SmithersError from an adapter](/guides/raise-an-error/): the
  adapter author's side, including how to subclass.
- [Error code reference](/reference/error-codes/) and
  [API reference](/reference/api/).
