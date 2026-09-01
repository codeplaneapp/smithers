# Hosted remote cache

This directory deploys the hosted smithers build remote cache to Cloudflare with
[Alchemy](https://alchemy.run). Production serves
`https://build.smithers.sh`. The Worker stores action-cache JSON in D1 and
content-addressed blobs in R2.

The hosted service and the self-hosted service under [`../terraform/`](../terraform/)
serve the same HTTP protocol. A client can switch between them by changing the
endpoint and bearer token; cache keys and payloads do not change.

The service has two credentials: one that may read and one that may publish.
[`CACHE-TRUST.md`](./CACHE-TRUST.md) states the trust model, which secret
belongs in which CI job, and the order to roll the two out in.

## Before you begin

Use Node.js 22 or later and install the pinned dependencies without running
package lifecycle scripts:

```sh
cd infra
npm ci --ignore-scripts
```

Provide these credentials in the deploying shell:

- `SMITHERS_CACHE_READ_TOKEN` and `SMITHERS_CACHE_WRITE_TOKEN`: The two bearer
  tokens used to derive the Worker's Cloudflare `secret_text` verifiers. Use at
  least 32 random bytes each. The Worker receives only their SHA-256 digests;
  do not put a bearer value in an `.env` file or source control. Both are
  required, and a deployment that has not separated its credentials yet sets
  both to the same value.
- Cloudflare authentication: Set `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` for non-interactive deployments, or authenticate
  interactively with Cloudflare OAuth. You can use `wrangler whoami` to check
  an existing Wrangler OAuth login. Alchemy currently keeps its own OAuth
  profile, so run `npx alchemy login --configure` and choose OAuth on the first
  Alchemy deployment if you do not set an API token.

Generate the bearer tokens in the current shell without writing them to disk:

```sh
export SMITHERS_CACHE_READ_TOKEN="$(openssl rand -hex 32)"
export SMITHERS_CACHE_WRITE_TOKEN="$(openssl rand -hex 32)"
```

The Cloudflare account must already contain the `smithers.sh` zone. The API
token or OAuth grant needs permission to manage Workers, D1, R2, and the
Worker custom domain in that zone.

The stack uses Alchemy's local state backend under `.alchemy/`. Keep that
ignored directory available to the deployment operator so later plans can
compare against the resources already deployed. This avoids requiring the
account-wide Cloudflare Secrets Store permissions needed by
`Cloudflare.state()`. The repository's deploy scripts also run
`scripts/redact-state.ts`, including after a failed Alchemy command, to scrub
any legacy state that contains the raw bearer value. Current state contains
only the one-way verifier. Use the scripts instead of calling `alchemy deploy`
directly.

## Deploy production

Preview the production plan:

```sh
CI=1 npx alchemy plan alchemy.run.ts --stage prod
```

Apply it:

```sh
CI=1 npm run deploy -- --yes
```

The `CI=1` prefix is for the environment-token path. Omit it when you use an
interactive Alchemy OAuth profile.

Alchemy creates a stage-specific D1 database and R2 bucket, applies every SQL
file in `worker/migrations/` in order, deploys the Worker with the four
bindings, and attaches `build.smithers.sh` as its custom domain. Migration
`0001_initial.sql` creates the table; `0002_bound_cache_rows.sql` constrains
existing and future body/discriminator sizes. The
production Worker does not expose a `workers.dev` URL.

## Deploy a development stage

Run the development script without `--stage`:

```sh
npm run deploy:dev
```

Alchemy uses its default `dev_$USER` stage. Development stages get independent
D1, R2, and Worker resources and use a `workers.dev` URL instead of claiming
the production custom domain.

## Verify the service

`GET` and `HEAD /healthz` are public readiness probes. They check D1 and R2,
return no cache state, and coalesce successful probes for one second:

```sh
curl --fail-with-body https://build.smithers.sh/healthz
```

Every `/ac` and `/cas` request requires a bearer token. `GET`, `HEAD`, and
`POST /cas/findMissing` accept either credential. `PUT` and `DELETE` require the
write credential and answer `403` to the read one, before the request body is
read.

Run the unit tests and TypeScript check locally:

```sh
npm test
npm run check
```

## Protocol

All artifact digests are 64 lowercase hexadecimal SHA-256 values. Action-cache
keys are the CLI's sanitized, non-empty path segments.

| Request                  | Success response       | Behavior                                                                                                            |
| ------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /ac/{keyDigest}`    | `200` JSON             | Returns the original JSON bytes and updates D1 access metadata in the same statement. Missing entries return `404`. |
| `PUT /ac/{keyDigest}`    | `201`, `200`, or `409` | First writer wins. A new entry returns `201`; an identical result returns `200`; a different result returns `409`.  |
| `DELETE /ac/{keyDigest}` | `200`                  | Deletes an entry, or returns `404`. Supply `recordedRunId` and `recordedEventSeq` together for a fenced delete.     |
| `GET /cas/{digest}`      | `200` bytes            | Streams an R2 object as `application/octet-stream`; missing objects return `404`.                                   |
| `PUT /cas/{digest}`      | `201` or `200`         | Hashes the complete upload before an atomic R2 publication. A digest mismatch returns `400`.                        |
| `HEAD /cas/{digest}`     | `200`                  | Checks R2 without returning a body; missing objects return `404`.                                                   |
| `POST /cas/findMissing`  | `200` JSON             | Accepts `{"digests":[...]}` and returns unique missing digests in request order.                                    |

The `/ac` body can be the CLI's `CachedResult` JSON verbatim or the richer
`CacheEntry` envelope. A document is an envelope only when it contains both
`keyDigest` and `result`; its key must match the request path. Conflict
classification uses the envelope's `result`, and uses the whole document for
every other shape. Object keys are canonicalized before comparison, while the
first writer's original JSON text is preserved for reads.

Requests use these bounds:

- `/ac` JSON body: 1 MiB.
- `/cas` upload: 16 MiB and `application/octet-stream`.
- `/cas/findMissing`: 256 KiB, at most 1,000 digests, and
  `application/json`.

JSON is also bounded to depth 64, 100,000 aggregate members, a 2 MiB canonical
conflict discriminator, and 16,384 stream chunks. Action keys are at most 512
UTF-8 bytes and one publication may reference at most 1,000 artifacts.

One isolate admits at most 64 cache requests, with independent route ceilings
of four action-cache publications, eight `findMissing` requests, and two large
artifact transfers. Excess work returns `429` with `Retry-After: 1` and its
request body is cancelled without waiting for a hostile cancellation promise.

Malformed input returns `400`, unsupported content types return `415`, and
oversized input returns `413`. Unsupported methods return `405`. An internal
storage refusal returns `503`, which clients treat as retryable rather than as
a cache miss.

The deploy wrapper forwards termination to the Alchemy process group, waits a
bounded grace period, escalates when necessary, and runs state redaction after
success, failure, or signal. Redaction uses bounded descriptor-stable reads and
atomic durable publication; use the wrapper instead of invoking Alchemy deploy
directly.

## Self-host instead

Use [`../terraform/`](../terraform/) when cache data must remain on
self-managed Docker, Postgres, and local storage. That stack remains supported
and independent of these Cloudflare resources. It exposes the same `/ac` and
`/cas` routes, so no cache-data or client-protocol migration is required.
