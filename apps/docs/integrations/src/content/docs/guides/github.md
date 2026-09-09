---
title: "GitHub"
description: "Configure the GitHub adapter: credentials, REST calls, verified webhook ingress, declared webhook reconciliation, and the comment action."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/integrations/docs/guides/github.md"
---

How to wire the GitHub adapter into a host application. Each section is a
recipe; the [API reference](/reference/api/) has the full signatures.

## Configure credentials

The client reads its token from explicit configuration first, then
`SMITHERS_GITHUB_TOKEN`, then `GITHUB_TOKEN`. The REST endpoint reads
`SMITHERS_GITHUB_API_BASE_URL` for GitHub Enterprise.

`GitHub.Config.resolve` reads `SMITHERS_GITHUB_WEBHOOK_SECRET` when no
explicit secret is supplied. The webhook channel requires an explicit secret
resolver: the host must pass the resolved non-empty `webhookSecret` through
`Core.Channel.constantSecret`, or use `Core.Channel.credentialSecret` with
its credential store.

```bash
export SMITHERS_GITHUB_TOKEN=TOKEN
export SMITHERS_GITHUB_WEBHOOK_SECRET=SECRET
```

Replace `TOKEN` with a personal access or installation token, and `SECRET`
with the webhook signing secret.

Passing an `env` record as the second argument to `make`, `layer`, or
`resolve` replaces the ambient environment rather than layering over it, so
code that carries its own credentials cannot have an ambient `GITHUB_TOKEN`
decide which account a call runs as.

## Call the REST API

Build the client with `GitHub.GitHubClient.make` for direct use, or
`GitHub.GitHubClient.layer` when a flow composition needs it in context.

```ts
import { GitHub } from "@smthrs/integrations"
import { Effect } from "effect"

const client = GitHub.GitHubClient.make({})

const program = Effect.gen(function*() {
  const viewer = yield* client.request<{ login?: unknown }>("GET", "/user")
  return viewer.login
})
```

`request` retries a rate limit for every method, waiting the server's
`Retry-After` or `x-ratelimit-reset` capped at one minute. A 5xx or a dropped
connection is retried only for a read. On a write it reports
`outcomeUnknown: true` in the failure's `details`, because GitHub may have
applied the write and lost the answer. If you know your endpoint is
idempotent, opt into repeating writes per call:

```ts
yield * client.request("POST", path, body, { retryUnsafeWrites: true })
```

To walk a list endpoint, use `paginate`, which follows `Link: rel="next"`
inside a page budget and tells you when the budget ran out:

```ts
const page = yield * client.paginate("/repos/OWNER/REPO/issues", { perPage: 100, maxPages: 10 })
if (page.truncated) {
  // `page.items` is a prefix, not the whole resource. Narrow the query or
  // raise maxPages (at most 1000) before reconciling against it.
}
```

Replace `OWNER` and `REPO` with the repository coordinates.

## Build repository paths safely

Never interpolate an owner or repository string into a request path yourself.
`encodeURIComponent("..")` is `".."`, and the URL parser removes dot segments
afterwards, so an unvalidated string walks the token-bearing request to a
different GitHub endpoint on the same origin. `repositoryPath` validates each
segment against GitHub's naming rules and only then encodes it:

```ts
const repository = yield * GitHub.Repository.requireRepositoryPath(owner, repo)
yield * client.request("GET", `/repos/${repository}`)
```

The throwing form, `GitHub.Repository.repositoryPath`, raises an
`IntegrationError` with reason `invalid-config`; the `require*` forms put the
same failure in the Effect channel.

## Receive webhooks

Construct a channel with the signing secret and a route, register it with
`Channels`, and hand every incoming POST to `Channels.ingest`. The example
uses a Node HTTP server with a 1 MiB (1,048,576 byte) body limit. It counts
streamed bytes before ingestion, including chunked requests, and responds
413 above the limit. It stops reading, clears buffered chunks, and destroys
the request after flushing the response. Aborted and failed requests also
release their buffered chunks. Any transport must bound the raw body before
calling `Channels.ingest`.

```ts
import * as Channels from "@smthrs/control/Channels"
import { Core, GitHub } from "@smthrs/integrations"
import { Effect, Redacted } from "effect"
import { createServer } from "node:http"

const channel = GitHub.Webhook.channel({
  credential: Redacted.make({ id: "github-webhook", name: "github-webhook" }),
  secret: Core.Channel.constantSecret(Redacted.make(webhookSecret)),
  route: Core.Channel.startFlow("triage")
})

const maxBodyBytes = 1024 * 1024
const server = createServer((request, response) => {
  const chunks: Array<Uint8Array> = []
  let receivedBytes = 0
  let stopped = false
  const discard = () => {
    stopped = true
    chunks.length = 0
  }
  request.on("aborted", discard)
  request.on("error", () => {
    discard()
    response.destroy()
  })
  request.on("data", (chunk: Uint8Array) => {
    if (stopped) return
    receivedBytes += chunk.byteLength
    if (receivedBytes > maxBodyBytes) {
      discard()
      request.pause()
      response.writeHead(413, { Connection: "close" }).end(() => request.destroy())
      return
    }
    chunks.push(chunk)
  })
  request.on("end", () => {
    if (stopped) return
    const body = Buffer.concat(chunks)
    discard()
    const program = Effect.gen(function*() {
      const channels = yield* Channels.Channels
      const raw = {
        body,
        headers: request.headers as Record<string, string | undefined>
      }
      return yield* channels.ingest({
        channel: "github",
        raw: { ...raw, idempotencyKey: GitHub.Webhook.idempotencyKey(raw) as string }
      })
    })
    Effect.runPromise(Effect.provide(program, channelsLayer)).then(
      () => response.writeHead(200).end(),
      () => response.writeHead(401).end()
    )
  })
})
```

Replace `webhookSecret` with the non-empty secret from
`GitHub.Config.resolve().webhookSecret`, and `channelsLayer` with
the layer that provides `Channels` over your control plane (see
[the control API](https://control.smithers.sh/reference/api/)).

Three details are load-bearing:

- The body is the exact bytes GitHub sent. The signature covers those bytes,
  so parsing first and re-serializing breaks verification.
- The `idempotencyKey` comes from `GitHub.Webhook.idempotencyKey`, which
  reads `X-GitHub-Delivery`. `ingest` drops a replayed key, which is what
  makes GitHub's redelivery after a timeout safe to accept. Leave it unset
  and a redelivery starts a second flow.
- A refused delivery fails `Unauthorized` before the decoder or the control
  plane runs. Only the refusal crosses; the digest detail stays in the log.

### Who is allowed to start work

A verified HMAC authenticates the delivery, but public-repository comments
can come from untrusted accounts. The channel requires the event author's
`author_association` to match `OWNER`, `MEMBER`, or `COLLABORATOR` by default,
and always refuses `sender.type === "Bot"`.

Configure the list per channel:

```ts
const channel = GitHub.Webhook.channel({
  credential: Redacted.make({ id: "github-webhook", name: "github-webhook" }),
  secret: Core.Channel.constantSecret(Redacted.make(webhookSecret)),
  route: Core.Channel.startFlow("triage"),
  allowedAssociations: ["OWNER", "MEMBER"]
})
```

An empty list admits nobody. Associations are compared without regard to
case. A comment or review uses its own association, never its parent issue
or pull request's association. Missing associations fail closed; this also
refuses event types such as `push` that do not supply an author association.

`GitHub.Webhook.senderRefusal` returns a `SenderRefused` error with reason
`permission-denied` and a typed `skipReason`: `bot-sender`,
`missing-association`, or `association-not-allowed`. `decode` throws that
error. The channel reports it as `InvalidInput` and never calls the route or
control plane. An ingress that needs to acknowledge a skipped delivery can
inspect `senderRefusal` after verifying its HMAC.

[How adapters sit on the control plane](/concepts/control-plane/)
explains the full contract, including `signalRun` for signaling a waiting run
instead of starting a flow.

## Declare and reconcile webhooks

`GitHub.ListenerRegistry` keeps a repository's hooks in line with a
declaration the workspace owns, `.smithers/listeners.json`:

```json
{
  "version": 1,
  "listeners": [
    {
      "id": "triage",
      "provider": "github",
      "repository": "OWNER/REPO",
      "events": ["issues", "issue_comment", "pull_request"],
      "flowId": "triage",
      "callbackUrl": "https://HOST/webhooks/triage",
      "secretEnv": "SMITHERS_GITHUB_WEBHOOK_SECRET",
      "active": true
    }
  ]
}
```

Replace `OWNER/REPO` with the repository, `HOST` with your ingress host, and
`triage` with the flow id where both differ. The callback path must be
exactly `/webhooks/<flowId>`, and the URL must be HTTPS without embedded
credentials, query parameters, or a fragment. `events` accepts `issues`,
`issue_comment`, `pull_request`, `pull_request_review`, and
`pull_request_review_comment`. `secretEnv` names the environment variable
holding this listener's signing secret.

Plan first. `reconcile` without `apply` performs no mutation:

```ts
import { GitHub } from "@smthrs/integrations"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const result = yield* GitHub.ListenerRegistry.reconcile({})
  return result.actions
})
```

Then apply, and only then allow deletes:

```ts
// Create and update hooks to match the declaration.
yield * GitHub.ListenerRegistry.reconcile({ apply: true })
// Also delete owned hooks the declaration no longer names.
yield * GitHub.ListenerRegistry.reconcile({ apply: true, allowDelete: true })
```

The token needs fine-grained Webhooks read/write permission or classic
`admin:repo_hook` access; reconciliation maps a 401, 403, or 404 on the hook
list to `permission-denied` saying exactly that.

The safety rules, all enforced rather than documented:

- **Ownership.** A hook is owned only when its numeric GitHub id is in
  `.smithers/listeners.state.json`. An unowned hook on a declared callback
  URL is a `conflict`, and `apply` fails with `listener-conflict` rather than
  adopting or modifying it. Adopt the hook manually or choose a different
  callback URL.
- **Deletes are opt-in.** Without `allowDelete`, a delete is skipped, and so
  is the create half of a repository move, because applying it alone would
  leave two live hooks for one listener.
- **Crash convergence.** A create is recorded as pending before the POST and
  confirmed after. A run that dies in between adopts its own hook next time
  instead of reporting a permanent conflict against its own work. The record
  expires after a day and is dropped the moment the declaration changes.
- **One hook per pair.** Two listeners naming one repository and one callback
  URL are refused at parse time: that pair is a single GitHub hook, and
  declaring it twice doubles every overlapping delivery. The same URL in a
  different repository is fine; one flow can be fed by several repositories.
- **State file integrity.** A state file that exists but cannot be parsed is
  fatal, because reconciling without knowing what the workspace owns is how
  somebody else's hook gets deleted. An apply holds `.smithers/listeners.lock`
  against a second concurrent apply. State writes refuse symbolic links at
  `.smithers` or `listeners.state.json`. Each write exclusively creates a
  random temporary file with mode `0600`, syncs it, and atomically replaces
  the state file.

A repository with more hooks than one reconciliation can read (ten pages of
100) fails `delivery-failed` rather than planning against a truncated list,
because the plan would emit a `create` for an owned hook it simply did not
see.

## Comment on an issue from a flow

`GitHub.Actions.CommentOnIssue` posts a comment as a durable step. The
payload's `owner`, `repo`, and `issueNumber` are validated by the payload
schema itself, so a payload built from a webhook body or a model's output
fails to decode rather than reaching the API with a hostile path.

```ts
import { GitHub } from "@smthrs/integrations"

const body = (input: typeof GitHub.Actions.CommentOnIssuePayload.Type) =>
  GitHub.Actions.CommentOnIssue.call({ ...input, body: "Triaged." })
```

The [quickstart](/quickstart/) shows the complete wiring: the flow, the
implementation layer, and the client layer. The action fails with
`Core.ActionFailure.IntegrationFailure`; when `outcomeUnknown` is set, the
comment may already exist, so check the issue before posting again.

## Add another endpoint

The three actions are declarations over the client, not a closed set. Write
your own `Action.make` over `GitHubClient` for any other endpoint; the client
carries the rate-limit, pagination, and credential behavior, and the action
makes it journaled. [Durable actions](/concepts/durable-actions/) shows
the shape.
