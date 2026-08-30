---
description: "The GitHub, Linear, and Telegram adapters: clients, webhook channels, schemas, and durable actions."
---

# `@smthrs/integrations`

This page is the API reference for the GitHub, Linear, and Telegram adapters.

The package is private at `1.0.0-rc.0`: no consumer on the registry imports it.
It is documented here because it is the worked example of what a Smithers
integration is: a narrow host layer with a verified door into the control
plane, and no opinion above that line.

GitHub and Linear are the two integrations the `1.0.0-rc.0` release smoke
exercises against live APIs.

## The shape of an integration

Four things, per provider:

1. **A client.** Authentication, rate limits, pagination, and credential
   hygiene. Everything a caller would otherwise get wrong against that API.
2. **A channel.** A `@smthrs/control` `Channel` that verifies an inbound
   webhook and turns it into one normalized event.
3. **Schemas.** The payload fields worth typing, with everything else passing
   through untouched.
4. **Actions.** The durable steps a flow calls: `GitHub.Actions.CommentOnIssue`,
   `Linear.Actions.CreateIssue`, `Telegram.Actions.SendMessage`. Each declares
   its payload, its success, and `IntegrationFailure` as its error, so the
   engine can journal the result and replay it instead of posting twice.

What an event *means*, which flow a pull request starts and which run an issue
comment signals, stays a Flow the application writes. A provider adapter that
decided that for you would be a framework.

## Webhook ingress

Smithers 1.0 has no listener verb and no gateway-level webhook
configuration. A webhook door is library code:

```ts
import * as Channels from "@smthrs/control/Channels"
import { Core, GitHub } from "@smthrs/integrations"
import { Effect, Redacted } from "effect"

const channel = GitHub.Webhook.channel({
  credential: Redacted.make({ id: "github-webhook", name: "github-webhook" }),
  secret: Core.Channel.constantSecret(Redacted.make(secret)),
  route: Core.Channel.startFlow("triage")
})

const program = Effect.gen(function*() {
  const channels = yield* Channels.Channels
  yield* channels.register(channel)
  return yield* channels.ingest({ channel: "github", raw })
})
```

`Channels.ingest` runs one fixed order: verify the raw bytes, decode, map,
then reach `Control`. Verification is the amplification guard, so a delivery
that does not verify never reaches a decoder, a plan, or a database. Ingest
also drops a replayed `idempotencyKey`, which is what makes accepting a
provider redelivery safe.

`secret` is how the channel obtains the signing secret behind a credential
reference. `Core.Channel.constantSecret` is for a single-tenant deployment that
reads one secret from its environment; `Core.Channel.credentialSecret` resolves
through the control plane's credential store.

`route` decides what the event does. `Core.Channel.startFlow(flowId)` starts a
flow with the event as input; `Core.Channel.signalRun(runId)` signals a run
that is already waiting. There is no broadcast: rc.0 does not deliver one event
to every run parked on a matching name.

## Verification

`Core.Signature.verifySignature` is the constant-time HMAC-SHA256 check every
webhook source uses. It accepts GitHub's `sha256=<hex>`, Linear's bare hex, and
a base64 digest. It returns `false` and never throws for a missing signature,
an empty secret, a wrong prefix, or an undecodable digest.

The comparison is `Core.Signature.constantTimeEqual`, which always scans the
longer of its two inputs and folds the length difference into the accumulator.
An early return on the first differing byte would make the endpoint an oracle
that leaks the expected digest one byte at a time to anyone who can time it.

Linear webhooks are checked twice: the signature, and then the
`webhookTimestamp` freshness window. A valid signature never expires, so
without the window a captured delivery would be replayable forever.

## Events and signals

One delivery decodes to one `Core.ExternalEvent`:

| Field | What it is |
| --- | --- |
| `source` | `github`, `linear`, `telegram` |
| `eventName` | `integration:<service>:<event>`, the most specific form the payload supports |
| `correlationId` | What the event is about, or `null` |
| `payload` | The provider payload, as delivered |
| `dedupeKey` | The provider's delivery identity, so a redelivery is recognizable |
| `receivedAtMs` | When it arrived |

The `integration:` prefix is reserved. `Core.SignalName.eventName` builds a
name, `parse` splits one, and `receivedBy` is the attribution stamped on a
delivered signal. `toSignalPayload` produces the control-plane signal;
`toNotification` produces a queued `system-event` that coalesces on
`<eventName>:<correlationId>`, so a burst of edits to one issue leaves one
pending notification carrying the newest payload.

Each provider also exposes the full ordered ladder its payload answers to, for
a caller that routes on a broader form:

| Provider | Names | Correlations |
| --- | --- | --- |
| GitHub | `…:pull_request.opened`, then `…:pull_request` | `owner/repo#12`, `owner/repo`, `null` |
| Linear | `…:issue.update`, then `…:issue` | `ENG-123`, `ENG`, `null` |

## Cursors

`Core.CursorStore` persists a polling source's cursor. `layerMemory` keeps it
for the life of the process; `layerSql` keeps it in the control database, over
the migration in `core/migrations`.

The contract that matters is ordering: a proposed cursor is committed only
after the batch it acknowledges has been handled. A process that dies mid-batch
re-polls that batch instead of skipping it, and the redelivery is dropped
downstream on the event's dedupe key.

## Declared GitHub webhooks

`GitHub.ListenerRegistry` reconciles a `.smithers/listeners.json` declaration
against a repository. `plan` is pure and performs no requests; `reconcile`
plans by default and applies only with `apply: true`.

Ownership is the safety property. A hook is owned only when its numeric GitHub
id appears in `.smithers/listeners.state.json`; a matching callback URL proves
nothing, because anyone can point a hook anywhere. So:

- an unowned hook on a declared URL is a `conflict`, and `apply` refuses rather
  than adopting it;
- an unowned hook elsewhere in the repository is `leave`, reported once;
- a delete needs `allowDelete: true` on top of `apply`, and the create half of
  a repository move is skipped when its delete was refused, because applying
  the create alone would leave two live hooks for one listener;
- ownership is written after every remote mutation, so a failure partway
  through leaves a state file the next run converges from.

A state file that exists but cannot be parsed is fatal. Reconciling without
knowing what this workspace owns is how somebody else's hook gets deleted.

## OAuth

`Core.Pkce.createPkcePair` returns an RFC 7636 S256 verifier and challenge;
`Core.AuthorizationUrl.buildAuthorizationUrl` builds the RFC 6749
authorization-code request around it. Both are for the GitHub and Linear OAuth
apps, where an intercepted authorization code would otherwise be redeemable by
whoever caught it.

## Credential hygiene

A token reaches the `Authorization` header and nothing else. It is not in a
message, not in `details`, and not in a log line, and the Telegram client
additionally strips its token from errors it did not construct, because the
token is in the request path and a transport error quotes the URL.

Every GitHub request URL is pinned to the configured API origin, including a
`Link: rel="next"` target. A redirected page link that left the origin would
hand the token to whoever received it.

Every client takes an `env` argument that replaces the ambient environment
rather than layering over it, so a caller that supplies its own credentials
cannot have an ambient `GITHUB_TOKEN` decide which account a call runs as.

## Actions

Each provider ships one durable action over its client. The client is an
ordinary Effect service; the action is what makes a call a step of a flow, so
the engine journals the result and a restart replays it instead of posting a
second comment.

| Action | Tag | Does |
| --- | --- | --- |
| `GitHub.Actions.CommentOnIssue` | `integrations/github/comment-on-issue` | Comments on an issue or pull request. |
| `Linear.Actions.CreateIssue` | `integrations/linear/create-issue` | Files an issue, resolving team, state, and label names to ids. |
| `Telegram.Actions.SendMessage` | `integrations/telegram/send-message` | Sends a message, chunked, with the markdown fallback. |

All three are `tier: "irreversible"`. The remote side has acted by the time the
call returns, so the engine never retries one on its own.

A flow calls the declaration and provides the implementation layer plus the
client the layer needs:

```ts
import { Flow } from "@smthrs/flow"
import { Core, GitHub } from "@smthrs/integrations"
import { Layer, Schema } from "effect"

const Triage = Flow.make("triage", {
  payload: { owner: Schema.String, repo: Schema.String, issueNumber: Schema.Number },
  success: GitHub.Actions.Comment,
  error: Core.ActionFailure.IntegrationFailure,
  body: (input) =>
    GitHub.Actions.CommentOnIssue.call({ ...input, body: "Triaged." })
})

const layer = Layer.provideMerge(
  GitHub.Actions.layer,
  GitHub.GitHubClient.layer({ token: process.env["GITHUB_TOKEN"] })
)
```

`.call(payload)` records a plan node and runs nothing. The node demands the
requirement that `GitHub.Actions.layer` provides, so a composition that forgot
the layer fails to compile rather than at run time.

An action fails with `Core.ActionFailure.IntegrationFailure`, the schema form
of `IntegrationError`: a `reason`, a message already safe to persist, and
`retryable`. A class cannot cross the journal; this can.

An application that needs an endpoint these three do not cover writes its own
`Action.make` over the same client. That is the intended extension point, not a
gap.

## Errors

Every failure is one `Core.IntegrationError` carrying a machine-readable
`reason`, so a caller maps it without reading message text:

| Reason | Raised when |
| --- | --- |
| `invalid-config` | A declaration or option is unusable. |
| `invalid-signature` | A webhook signature did not verify. |
| `decode-failed` | A payload or response could not be read as expected. |
| `poll-failed` | A polling source's request failed. |
| `delivery-failed` | An API call failed. `details.retryable` says whether another attempt is worth making. |
| `credentials-missing` | A required credential was not configured. |
| `permission-denied` | The credential lacks the scope the operation needs. |
| `listener-conflict` | An unowned hook holds a declared callback URL. |

`toUnauthorized` and `toInvalidInput` map a failure onto the control plane's
own errors at the channel boundary. Only the reason crosses: a verifier that
reported which byte of a digest mismatched would be a verification oracle.

## Tests

The client and webhook suites drive a real `node:http` fixture server over a
real socket. Nothing in this package mocks a transport.

Three suites talk to the live APIs and skip, naming the credential, when it is
absent: `GITHUB_TOKEN`, `LINEAR_API_KEY`, `TELEGRAM_BOT_TOKEN`. All three are
read-only. They are listed in the pin register in `docs/alpha-notes.md`.
