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

What an event _means_, which flow a pull request starts and which run an issue
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
  return yield* channels.ingest({
    channel: "github",
    // The redelivery guarantee lives here. `ingest` drops a replayed
    // `idempotencyKey`, and nothing derives one for you.
    raw: { ...raw, idempotencyKey: GitHub.Webhook.idempotencyKey(raw) }
  })
})
```

`Channels.ingest` runs one fixed order: verify the raw bytes, decode, map,
then reach `Control`. Verification is the amplification guard, so a delivery
that does not verify never reaches a decoder, a plan, or a database.

Ingest also drops a replayed `idempotencyKey`, which is what makes accepting a
provider redelivery safe. That key is the caller's to supply on the
`RawInbound` it hands `ingest`. Each provider exports the derivation:
`GitHub.Webhook.idempotencyKey(raw)` reads `X-GitHub-Delivery`,
`Linear.Webhook.idempotencyKey(raw, payload)` reads `Linear-Delivery` and falls
back to the delivery's own identity, and `Telegram.Source.idempotencyKey(event)`
is the source-scoped update key. An ingress that leaves the field unset has no
redelivery protection at all.

`secret` is how the channel obtains the signing secret behind a credential
reference. `Core.Channel.constantSecret` is for a single-tenant deployment that
reads one secret from its environment; `Core.Channel.credentialSecret` resolves
through the control plane's credential store.

`route` decides what the event does. `Core.Channel.startFlow(flowId)` starts a
flow with the event as input; `Core.Channel.signalRun(runId)` signals a run
that is already waiting. There is no broadcast: rc.0 does not deliver one event
to every run parked on a matching name.

A provider decoder's output is validated against `Core.ExternalEvent` before it
leaves the channel, so a decoder bug fails on the delivery that triggered it
rather than surfacing as a malformed signal three hops later. A verifier or a
decoder that throws is a refusal, not a crash: the delivery fails
`Unauthorized` or `InvalidInput`, and the internal message stays in the log
rather than crossing to the control plane.

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
without the window a captured delivery would be replayable forever. The window
is bounded at both ends and capped at an hour; a skew of `Infinity` would
disable the check, so it is refused rather than honored.

## Events and signals

One delivery decodes to one `Core.ExternalEvent`:

| Field           | What it is                                                                   |
| --------------- | ---------------------------------------------------------------------------- |
| `source`        | `github`, `linear`, `telegram`                                               |
| `eventName`     | `integration:<service>:<event>`, the most specific form the payload supports |
| `correlationId` | What the event is about, or `null`                                           |
| `payload`       | The provider payload, as delivered                                           |
| `dedupeKey`     | The provider's delivery identity, so a redelivery is recognizable            |
| `receivedAtMs`  | When it arrived                                                              |

The `integration:` prefix is reserved. `Core.SignalName.eventName` builds a
name, `parse` splits one, and `receivedBy` is the attribution stamped on a
delivered signal. The two are symmetric: a name the constructor refuses to
build, such as one whose event segment carries a second colon, parses as `null`
rather than becoming an identity nothing can reproduce. `toSignalPayload`
produces the control-plane signal; `toNotification` produces a queued
`system-event` that coalesces on `<eventName>:<correlationId>`, so a burst of
edits to one issue leaves one pending notification carrying the newest payload.

Each provider also exposes the full ordered ladder its payload answers to, for
a caller that routes on a broader form:

| Provider | Names                                          | Correlations                          |
| -------- | ---------------------------------------------- | ------------------------------------- |
| GitHub   | `…:pull_request.opened`, then `…:pull_request` | `owner/repo#12`, `owner/repo`, `null` |
| Linear   | `…:issue.update`, then `…:issue`               | `ENG-123`, `ENG`, `null`              |

Telegram dedupe keys carry the source id, because `update_id` is scoped per
bot: two configured sources would otherwise produce the same key for unrelated
updates, and the second bot's event would be dropped as a duplicate.

## Cursors

`Core.CursorStore` persists a polling source's cursor. `layerMemory` keeps it
for the life of the process; `layerSql` keeps it in the control database, over
the migration in `core/migrations`.

The contract that matters is ordering: a proposed cursor is committed only
after the batch it acknowledges has been handled. A process that dies mid-batch
re-polls that batch instead of skipping it, and the redelivery is dropped
downstream on the event's dedupe key. A stored cursor that does not parse as an
offset fails the poll rather than being dropped, because dropping it sends
`getUpdates` with no offset and replays Telegram's whole retained backlog.

## Pagination

`GitHub.GitHubClient.paginate` follows `Link: rel="next"` inside a declared
budget: `perPage` defaults to 100 and `maxPages` to 10, so the default ceiling
is a thousand items. Hitting the ceiling is reported as `truncated`, never as a
short but complete answer. `ListenerRegistry` refuses to plan against a
truncated hook list, because planning against one would emit a `create` for an
owned hook it simply did not see.

## Declared GitHub webhooks

`GitHub.ListenerRegistry` reconciles a `.smithers/listeners.json` declaration
against a repository. `plan` is pure and performs no requests; `reconcile`
plans by default and applies only with `apply: true`.

Ownership is the safety property. A hook is owned only when its numeric GitHub
id appears in `.smithers/listeners.state.json`; a matching callback URL proves
nothing, because anyone can point a hook anywhere. So:

- an unowned hook on a declared URL is a `conflict`, and `apply` refuses rather
  than adopting it. Every `create` runs that check, including the one for a
  listener that moved repositories and the one for a hook that was deleted
  remotely, because both land in a repository that may already have somebody
  else's hook on the same URL;
- an unowned hook elsewhere in the repository is `leave`, reported once;
- a delete needs `allowDelete: true` on top of `apply`, and the create half of
  a repository move is skipped when its delete was refused, because applying
  the create alone would leave two live hooks for one listener;
- a create is recorded as `pending` before the POST and confirmed as ownership
  after it. A process that dies in between leaves a state file the next run
  converges from: it recognizes the hook it was creating and adopts it, rather
  than reporting a permanent conflict against its own work. That inference is
  bounded, because an intent is evidence and not proof. The record is retired
  the moment GitHub says it refused the create, it is dropped when the
  declaration that produced it changes, it expires after a day, and adoption
  requires exactly one hook on the URL. Anything else is still a `conflict`;
- a `delete` is only planned for a hook that is still there, so a run that
  deleted the old half of a repository move and died before writing ownership
  finishes the move next time instead of retrying a delete GitHub answers 404.

An owner or a repository name is validated before it becomes part of a request
path. Encoding is not enough: `encodeURIComponent("..")` is `".."`, and the URL
parser removes dot segments afterwards, so an unvalidated repository string
walks a token-bearing request to a different GitHub endpoint on the same
origin. `GitHub.Repository.repositoryPath` is the only way this package builds
one, and `GitHub.Actions.CommentOnIssuePayload` demands the same shapes, so a
payload built from a webhook body or a model's output fails to decode rather
than reaching the API.

A state file that exists but cannot be parsed is fatal. Reconciling without
knowing what this workspace owns is how somebody else's hook gets deleted. Every
one of those file boundaries fails with an `IntegrationError` in the declared
channel, so a caller's `catchTag` sees a missing declaration rather than a
dead fiber.

## OAuth

`Core.Pkce.createPkcePair` returns an RFC 7636 S256 verifier and challenge;
`Core.AuthorizationUrl.buildAuthorizationUrl` builds the RFC 6749
authorization-code request around it. Both are for the GitHub and Linear OAuth
apps, where an intercepted authorization code would otherwise be redeemable by
whoever caught it.

`extraParams` is applied after the standard parameters, so a provider that
needs a different `response_type` can say so. It cannot replace `client_id`,
`redirect_uri`, `state`, `code_challenge`, or `code_challenge_method`: those
are the CSRF and PKCE bindings the builder validates, and overwriting one from
a provider-specific map would disable exactly what the validation is for.

## Credential hygiene

A token reaches the `Authorization` header and nothing else. It is not in a
message, not in `details`, and not in a log line, and the Telegram client
additionally strips its token from errors it did not construct, because the
token is in the request path and a transport error quotes the URL.

Every GitHub request URL is pinned to the configured API origin, including a
`Link: rel="next"` target. A redirected page link that left the origin would
hand the token to whoever received it. The origin pin is not a path pin, which
is why repository coordinates are validated separately.

Every client and the Telegram source take an `env` argument that replaces the
ambient environment rather than layering over it, so a caller that supplies its
own credentials cannot have an ambient `GITHUB_TOKEN` decide which account a
call runs as. Omitting it reads the host environment through the named
`Environment.ambientEnvironment` accessor, which is the one place this package
spells that decision.

## Actions

Each provider ships one durable action over its client. The client is an
ordinary Effect service; the action is what makes a call a step of a flow, so
the engine journals the result and a restart replays it instead of posting a
second comment.

| Action                          | Tag                                    | Does                                                           |
| ------------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| `GitHub.Actions.CommentOnIssue` | `integrations/github/comment-on-issue` | Comments on an issue or pull request.                          |
| `Linear.Actions.CreateIssue`    | `integrations/linear/create-issue`     | Files an issue, resolving team, state, and label names to ids. |
| `Telegram.Actions.SendMessage`  | `integrations/telegram/send-message`   | Sends a message, chunked, with the markdown fallback.          |

All three are `tier: "irreversible"`. The remote side has acted by the time the
call returns, so the engine never retries one on its own, and neither does the
client underneath it. A rate limit is retried for every method, because a
rejected request was not performed. A 5xx or a dropped connection on a write is
not: the provider may have committed it and lost the answer, so the failure
says `outcomeUnknown` instead of posting the comment twice. A caller that knows
its endpoint is idempotent opts in with `retryUnsafeWrites`.

`SendMessage` is the one action that is not atomic. Text over Telegram's
4096-character limit becomes several `sendMessage` calls inside the step, and a
failure partway through leaves the earlier chunks visible in the chat. The
failure names them, so an operator deciding whether to resend can see what the
reader already has.

A flow calls the declaration and provides the implementation layer plus the
client the layer needs:

```ts
import { Flow } from "@smthrs/flow"
import { Core, GitHub } from "@smthrs/integrations"
import { Layer } from "effect"

const Triage = Flow.make("triage", {
  payload: GitHub.Actions.CommentOnIssuePayload,
  success: GitHub.Actions.Comment,
  error: Core.ActionFailure.IntegrationFailure,
  body: (input) => GitHub.Actions.CommentOnIssue.call({ ...input, body: "Triaged." })
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
of `IntegrationError`: a `reason`, a message already safe to persist,
`retryable`, and two fields an operator reads after a restart.
`outcomeUnknown` says the provider may have applied the write and lost the
answer, which is a different answer from "this did not happen".
`deliveredMessageIds` names what a partially completed send already put in the
chat. A class cannot cross the journal; these can.

An application that needs an endpoint these three do not cover writes its own
`Action.make` over the same client. That is the intended extension point, not a
gap.

## Errors

Every failure that reaches a caller through the Effect channel, from a client,
a source, a channel, or a durable action, is one `Core.IntegrationError`
carrying a machine-readable `reason`, so a caller maps it without reading
message text:

| Reason                | Raised when                                                                                                                                                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid-config`      | A declaration, option, or stored cursor is unusable.                                                                                                             |
| `invalid-signature`   | A webhook signature did not verify.                                                                                                                              |
| `decode-failed`       | A payload or response could not be read as expected.                                                                                                             |
| `poll-failed`         | A polling source's request failed.                                                                                                                               |
| `delivery-failed`     | An API call failed. `details.retryable` says whether another attempt is worth making, and `details.outcomeUnknown` says the write may already have been applied. |
| `credentials-missing` | A required credential was not configured.                                                                                                                        |
| `permission-denied`   | The credential lacks the scope the operation needs.                                                                                                              |
| `listener-conflict`   | An unowned hook holds a declared callback URL.                                                                                                                   |

Two kinds of failure sit outside that channel and outside that vocabulary.

The Telegram client raises its own `TelegramApiError`, which carries the Bot
API's `error_code`. `Telegram.TelegramClient.toIntegrationError` is the mapping
onto the vocabulary above, and the durable action applies it, so an exhausted
rate limit journals `retryable: true` and a chat that does not exist journals
something a caller can tell apart from it.

The plan-time helpers validate their arguments by throwing, the way an ordinary
constructor does, rather than by returning an Effect: `Telegram.Config.resolve`,
`Telegram.Chunk.chunk`, `Telegram.Approval.callbackData` and its neighbours,
`Telegram.InitData.*`, `Core.SignalName.eventName`, `Core.AuthorizationUrl`, and
`GitHub.Repository.repositoryPath`. Each raises a `SmithersError` with a code
such as `INVALID_INPUT`, because a caller that passed a bad argument has a bug
to fix rather than a failure to journal. `GitHub.Repository` also exports
`requireRepositoryPath`, the same check inside the Effect channel, for the
paths that build a request from configuration.

`toUnauthorized` and `toInvalidInput` map a failure onto the control plane's
own errors at the channel boundary. Only the reason crosses: a verifier that
reported which byte of a digest mismatched would be a verification oracle.

The conversion into the journal is total. An error that only claims the
`IntegrationError` name, or that carries a reason a different build invented,
converts to a non-retryable `delivery-failed` rather than failing schema
validation inside `Effect.mapError`, where the throw would become a defect.
Persisted text is capped, and it is the error's `summary` rather than its
`message`, so one provider's failures do not carry a documentation URL the
others' do not.

## Tests

The client and webhook suites drive a real `node:http` fixture server over a
real socket. Nothing in this package mocks a transport.

Three suites talk to the live APIs and skip, naming the credential, when it is
absent: `GITHUB_TOKEN`, `LINEAR_API_KEY`, `TELEGRAM_BOT_TOKEN`. All three are
read-only. They are listed in the pin register in `docs/alpha-notes.md`.
