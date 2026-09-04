---
title: "@smthrs/integrations"
description: "GitHub, Linear, and Telegram adapters over the Smithers control plane."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/integrations/docs/README.md"
---

`@smthrs/integrations` is the provider adapter layer for a Smithers host
application. It gives each provider a client, a verified webhook channel,
payload schemas, and the durable actions a flow calls, all built on the
[control plane](https://control.smithers.sh/reference/api/).

You use this package when a Smithers application needs to answer a GitHub,
Linear, or Telegram event (a pull request opened, an issue updated, a button
pressed) or needs a flow to act on one of those providers (comment on an
issue, file an issue, send a message) as a journaled, replay-safe step.

What an event means, which flow a pull request starts and which run an issue
comment signals, stays a flow the application writes. The adapters stop at
verification, normalization, and transport.

## What is in the box

Each provider ships the same four parts:

- **A client.** Authentication, rate limits, pagination, and credential
  hygiene against the provider's API. The clients are ordinary Effect
  services you can also call directly with `make`.
- **A channel.** A `@smthrs/control` `Channel` that verifies an inbound
  webhook's signature and decodes the delivery into one normalized event.
  Telegram, which has no webhook signature to verify, ships a `getUpdates`
  long-poll source instead.
- **Schemas.** The payload fields worth typing, with everything else passing
  through untouched, so a delivery is never rejected for carrying a field
  this package has not heard of.
- **One durable action.** The step a flow calls, journaled so a restart
  replays the recorded result instead of acting twice.

| Action                          | Tag                                    | Does                                                           |
| ------------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| `GitHub.Actions.CommentOnIssue` | `integrations/github/comment-on-issue` | Comments on an issue or pull request.                          |
| `Linear.Actions.CreateIssue`    | `integrations/linear/create-issue`     | Files an issue, resolving team, state, and label names to ids. |
| `Telegram.Actions.SendMessage`  | `integrations/telegram/send-message`   | Sends a message, chunked, with a plain-text fallback.          |

The shared, provider-agnostic pieces (signature verification, the channel
binding, the normalized event, cursor persistence, the error vocabulary, and
the OAuth helpers) live in the `Core` namespace.

## Install

The package is private at `1.0.0-rc.0`: it is documented as the worked
example of a Smithers integration, and only code in the Smithers workspace
consumes it. Inside the workspace, add it with:

```bash
pnpm add @smthrs/integrations
```

Webhook ingress also imports the control plane's channel coordinator, and
durable flows import the flow and engine layers:

```bash
pnpm add @smthrs/control @smthrs/flow @smthrs/engine
```

Import one provider at a time when that is all you need. The aggregate entry
point and the per-provider subpaths export the same names:

```ts
import { Core, GitHub, Linear, Telegram } from "@smthrs/integrations"
// or only what you use:
import * as Core from "@smthrs/integrations/core"
import * as GitHub from "@smthrs/integrations/github"
import * as Linear from "@smthrs/integrations/linear"
import * as Telegram from "@smthrs/integrations/telegram"
```

## The smallest working example

A verified door for GitHub webhooks, registered with the control plane's
channel coordinator:

```ts
import * as Channels from "@smthrs/control/Channels"
import { Core, GitHub } from "@smthrs/integrations"
import { Effect, Redacted } from "effect"

const channel = GitHub.Webhook.channel({
  credential: Redacted.make({ id: "github-webhook", name: "github-webhook" }),
  secret: Core.Channel.constantSecret(Redacted.make(webhookSecret)),
  route: Core.Channel.startFlow("triage")
})

const register = Effect.flatMap(Channels.Channels, (channels) => channels.register(channel))
```

Replace `webhookSecret` with the secret GitHub signs deliveries with, read
from your environment or secret store.

`Channels.ingest` then runs one fixed order on every delivery: verify the raw
bytes, decode, map, dispatch. A delivery that does not verify never reaches a
decoder, a plan, or a database. For the redelivery guarantee that makes this
safe to expose to a provider, see
[how adapters sit on the control plane](/concepts/control-plane/).

## Credentials

Explicit configuration always wins. What it omits falls back to the
environment:

| Variable                                     | Used by                                      |
| -------------------------------------------- | -------------------------------------------- |
| `SMITHERS_GITHUB_TOKEN`, then `GITHUB_TOKEN` | `GitHub.GitHubClient`, `ListenerRegistry`    |
| `SMITHERS_GITHUB_API_BASE_URL`               | GitHub Enterprise or a fixture server        |
| `SMITHERS_GITHUB_WEBHOOK_SECRET`             | `GitHub.Webhook`                             |
| `SMITHERS_LINEAR_API_KEY`                    | `Linear.LinearClient`                        |
| `SMITHERS_LINEAR_WEBHOOK_SECRET`             | `Linear.Webhook`                             |
| `SMITHERS_LINEAR_API_BASE_URL`               | A fixture server                             |
| `SMITHERS_TELEGRAM_BOT_TOKEN`                | `Telegram.TelegramClient`, `Telegram.Source` |

Every client, and the Telegram source, takes an `env` argument that replaces
the ambient environment rather than layering over it, so a caller that
supplies its own credentials cannot have an ambient `GITHUB_TOKEN` decide
which account a call runs as.

## Where to go next

- [Quickstart](/quickstart/): from install to a durable GitHub comment, in
  a flow, against the live API.
- Guides per adapter: [GitHub](/guides/github/), [Linear](/guides/linear/),
  [Telegram](/guides/telegram/).
- Concepts: [how adapters sit on the control plane](/concepts/control-plane/),
  [events, signals, and cursors](/concepts/events-and-signals/), and
  [durable actions](/concepts/durable-actions/).
- [API reference](/reference/api/): every public export, with signatures and errors.
- [Testing](/testing/): the fixture and live suites.
- [Troubleshooting](/troubleshooting/): the failure modes the package
  raises, and what to do about each.
