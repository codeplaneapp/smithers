# @smthrs/integrations

**Documentation:** https://integrations.smithers.sh

GitHub, Linear, and Telegram adapters over the Smithers control plane.

This is a private workspace package. It is not published at `1.0.0-rc.0`
because no consumer on the registry imports it; it re-enters the public set
when one does.

## What it is

A narrow host layer plus the durable actions over it. Each provider gets a
client, a verified webhook channel, payload schemas, and the actions a flow
calls. What an application does with an event, which flow a pull request starts
and which run an issue comment signals, stays a Flow the application writes,
because that part is not a provider concern.

There is no `smthrs listeners` verb and no gateway-level webhook
configuration at 1.0. Webhook ingress is library code: a provider builds a
`@smthrs/control` `Channel`, the application registers it with `Channels`, and
`Channels.ingest` runs verify, decode, map, dispatch in that fixed order.

`Channels.ingest` drops a replayed `idempotencyKey`, which is what makes a
provider redelivery safe to accept. That key is yours to put on the
`RawInbound`: `GitHub.Webhook.idempotencyKey`, `Linear.Webhook.idempotencyKey`,
and `Telegram.Source.idempotencyKey` derive it from the provider's own delivery
identity. An ingress that leaves the field unset has no redelivery protection.

```ts
import * as Channels from "@smthrs/control/Channels"
import { Core, GitHub } from "@smthrs/integrations"
import { Effect, Redacted } from "effect"

const channel = GitHub.Webhook.channel({
  credential: Redacted.make({ id: "github-webhook", name: "github-webhook" }),
  secret: Core.Channel.constantSecret(Redacted.make(process.env.GITHUB_WEBHOOK_SECRET!)),
  route: Core.Channel.startFlow("triage")
})

const register = Effect.flatMap(Channels.Channels, (channels) => channels.register(channel))
```

Import one provider at a time when that is all you need:
`@smthrs/integrations/github`, `/linear`, `/telegram`, `/core`.

## What each part is for

### `core`

The service-agnostic pieces every provider shares.

- **`Signature`**: constant-time HMAC-SHA256 verification. A webhook signature
  is attacker-supplied, so `constantTimeEqual` always scans the longer input
  and folds the length difference into the result: an early return would turn
  the endpoint into an oracle that leaks the expected digest a byte at a time.
  GitHub's `sha256=<hex>`, Linear's bare hex, and base64 digests are accepted.
- **`Channel`**: the `WebhookChannel` binding, a secret resolver, the fixed
  verify-then-decode order, and the `startFlow` and `signalRun` routes.
- **`CursorStore`**: cursor persistence for polling sources, in memory or over
  the control database. The contract is that a cursor is committed _after_ the
  batch it acknowledges was handled.
- **`ExternalEvent`** and **`SignalName`**: the one normalized event shape, the
  reserved `integration:<service>:<event>` namespace, and the mapping onto
  `@smthrs/control` signals and `@smthrs/notifications` system events.
- **`IntegrationError`**: provider error classification, with a
  machine-readable `reason` and provider-safe details. `ActionFailure` is the
  schema form of it, which is what a durable action journals. The Telegram
  client raises its own `TelegramApiError`;
  `Telegram.TelegramClient.toIntegrationError` maps it onto the same
  vocabulary, and the durable action applies that mapping.
- **`Pkce`** and **`AuthorizationUrl`**: the RFC 7636 and RFC 6749 pieces of
  the GitHub and Linear OAuth flows.

### `github`

`GitHubClient` is a REST client that exists for three behaviors a bare `fetch`
does not have: rate-limit handling that recognizes a 429 _and_ the 403 forms
GitHub uses for a secondary limit, bounded `Link: rel="next"` pagination that
says when it hit its ceiling, and token hygiene. The token reaches the
`Authorization` header and nothing else, and every request URL is pinned to the
configured API origin so a redirected page link cannot carry it elsewhere.

The origin pin is not a path pin. `new URL` resolves `..` inside a path, and
`encodeURIComponent("..")` is `".."`, so a repository string interpolated into
a path would walk a token-bearing request to a different GitHub endpoint on the
same origin. `Repository.repositoryPath` validates each segment and is the only
way this package builds one.

`Webhook` verifies `X-Hub-Signature-256` over the exact delivered bytes, then
decodes one delivery into one event named and correlated at the most specific
form the payload supports. `names` and `correlations` expose the whole ordered
ladder for a caller that routes on a broader form.

`ListenerRegistry` reconciles declared webhooks against a repository. Its
safety property is ownership: a hook is owned only when its numeric GitHub id
is in this workspace's own state file, so an unowned hook on a declared URL is
reported as a `conflict` and never touched. Every `create` runs that check, not
only the one for a listener the state file has never seen. Deletes need an
explicit `allowDelete` on top of `apply`. A create is recorded as `pending`
before the request and confirmed after it, so a run that dies in between adopts
its own hook next time instead of refusing forever.

### `linear`

`LinearClient` is plain `fetch` over raw GraphQL. It resolves the names people
write, such as `ENG`, `In Progress`, `bug`, and `ENG-123`, into the ids
Linear's mutations take, and caches every lookup per client. A 429 is retried
up to five attempts honoring `Retry-After` or `X-RateLimit-Requests-Reset`, and
so is a 5xx on a query. A 5xx on `issueCreate`, `issueUpdate`, or
`commentCreate` is not: Linear may have applied it and lost the answer, so the
failure says the outcome is unknown rather than filing a second issue.

`Webhook` checks the `Linear-Signature` HMAC _and_ the `webhookTimestamp`
freshness window, because a valid signature never expires and a captured
delivery would otherwise be replayable forever.

### `telegram`

`TelegramClient` chunks at Telegram's 4096-character limit on paragraph,
sentence, and word boundaries; converts markdown to MarkdownV2; and resends a
chunk as plain text when Telegram rejects the entities, so a formatting failure
costs formatting rather than the message. The bot token is redacted from every
error, including one a transport raised with the URL in it.

`Source` is the `getUpdates` long poll. Its dedupe keys carry the source id,
because `update_id` is scoped per bot, and a configured `allowedChatIds` drops
an update whose chat it cannot determine rather than admitting it. `Approval`
is the inline-keyboard approval codec, where a press carries a per-approval
token and a foreign press fails safe; a prompt built with no token matches
nothing at all, and the token is a 32-bit namespace rather than a secret.
`InitData` verifies Mini App `initData` on both the HMAC and Ed25519 paths,
using Web Crypto and no `node:` builtin. That is what would let the same code
run under Bun and a Cloudflare Worker, but nothing here proves it: this package
declares no `bunTest` target, so it is in neither the Bun matrix nor the
browser-contract list in `scripts/browser-check.mjs`. Read it as Node, verified,
and everything else as untested.

## Actions

One durable action per provider, over the client of the same name:

| Action                          | Tag                                    |
| ------------------------------- | -------------------------------------- |
| `GitHub.Actions.CommentOnIssue` | `integrations/github/comment-on-issue` |
| `Linear.Actions.CreateIssue`    | `integrations/linear/create-issue`     |
| `Telegram.Actions.SendMessage`  | `integrations/telegram/send-message`   |

All three are `tier: "irreversible"`, because the remote side has acted by the
time the call returns. Neither the engine nor the client underneath repeats
one: a rate limit is retried for every method, since a refused request was not
performed, but a 5xx or a dropped connection on a write reports
`outcomeUnknown` instead of acting twice.

`SendMessage` is the one that is not atomic: text over 4096 characters becomes
several `sendMessage` calls inside the step, and a failure partway through
leaves the earlier chunks in the chat and names them in the failure.

`.call(payload)` records a plan node; `Actions.layer` provides the
implementation, and needs the provider's client in context. The error type is
`Core.ActionFailure.IntegrationFailure`, the schema form of
`IntegrationError`, because a class cannot cross the journal.

Writing another `Action.make` over the same client is the intended way to reach
an endpoint these three do not cover.

## Credentials

| Variable                                     | Used by                                      |
| -------------------------------------------- | -------------------------------------------- |
| `SMITHERS_GITHUB_TOKEN`, then `GITHUB_TOKEN` | `GitHub.GitHubClient`, `ListenerRegistry`    |
| `SMITHERS_GITHUB_API_BASE_URL`               | GitHub Enterprise or a fixture server        |
| `SMITHERS_GITHUB_WEBHOOK_SECRET`             | `GitHub.Webhook`                             |
| `SMITHERS_LINEAR_API_KEY`                    | `Linear.LinearClient`                        |
| `SMITHERS_LINEAR_WEBHOOK_SECRET`             | `Linear.Webhook`                             |
| `SMITHERS_LINEAR_API_BASE_URL`               | A fixture server                             |
| `SMITHERS_TELEGRAM_BOT_TOKEN`                | `Telegram.TelegramClient`, `Telegram.Source` |

Explicit configuration always wins. Every client, and `Telegram.Source`, takes
an `env` argument that _replaces_ the ambient environment rather than layering
over it, so a caller supplying its own credentials cannot have an ambient
`GITHUB_TOKEN` decide which account a call runs as. Omitting it reads the host
environment through `Environment.ambientEnvironment`, which is the one place
this package spells that decision.

## Tests

`pnpm --filter @smthrs/integrations test` runs the whole suite. The client and
webhook suites drive a real `node:http` fixture server over a real socket:
nothing here mocks a transport.

Three suites talk to the live APIs and skip, naming the credential, when it is
absent:

```sh
GITHUB_TOKEN=…  pnpm --filter @smthrs/integrations exec vitest run test/GitHubLive.test.ts --coverage.enabled=false
LINEAR_API_KEY=…  pnpm --filter @smthrs/integrations exec vitest run test/LinearLive.test.ts --coverage.enabled=false
TELEGRAM_BOT_TOKEN=…  pnpm --filter @smthrs/integrations exec vitest run test/TelegramLive.test.ts --coverage.enabled=false
```

`--coverage.enabled=false` is required. `vitest.config.ts` turns v8 coverage on
with global thresholds, and one file covers a few percent of `src`, so without
the flag every one of these commands exits 1 after its tests pass. Coverage is
measured over the whole suite instead:
`GITHUB_TOKEN=…  pnpm --filter @smthrs/integrations test -- --run`.

All three are read-only. The Telegram poll passes no offset, so it confirms
nothing and a running bot keeps its backlog.

## Documentation

`docs/` is this package's own prose, and `docs/pages/api/integrations.md` in
the repository is generated from it plus the JSDoc in `src/`:

```sh
node packages/smithers/agent/integrations/scripts/docs.mjs           # write the page
node packages/smithers/agent/integrations/scripts/docs.mjs --check   # report drift, exit 1
```

`PACKAGE.ts` declares the same thing as a `Smithers.Generate` target, so the
workspace `ci` step drift-checks it.

## Commands

```sh
pnpm --filter @smthrs/integrations test
pnpm --filter @smthrs/integrations check
pnpm --filter @smthrs/integrations lint
pnpm --filter @smthrs/integrations circular
```
