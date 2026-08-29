# bug-worker

Cloudflare Worker behind `https://bug.smithers.sh` that receives bug reports
from `smithers bug` (and anyone else) and stores them in KV.

## The payload

`smithers bug` posts the report plus, when `--run` names one, a digest of that
run. The digest is built from the control plane's own DTOs: a `RunSummary` for
the run and the tail of its `Watch` stream as `ControlEvent`s.

```jsonc
{
  "title": "Run run-01JQ… failed: the review step exhausted its correction budget",
  "body": "It failed the same way twice on a clean checkout.",
  "smithersVersion": "1.0.0-rc.0",
  "platform": { "os": "darwin", "arch": "arm64", "nodeVersion": "v22.19.0" },
  "createdAtMs": 1788000050000,
  "run": {
    "runId": "run-01JQ…",
    "flowId": "flows/build-and-review",
    // One of the seven rc.0 statuses: accepted, running, parked,
    // waiting-approval, cancelled, completed, failed.
    "status": "failed",
    "createdAt": 1788000000000,
    "updatedAt": 1788000042000,
    "error": "the review step exhausted its correction budget",
    "events": [{ "sequence": 3, "kind": "control.run.failed", "occurredAt": 1788000042000, "payload": {} }]
  }
}
```

0.x sent `workflowName` and `workflowPath` instead of `flowId`, a five-status
vocabulary, and events keyed `seq`/`timestampMs`/`type`. The worker still
stores those: it is deployed once and talks to every CLI version ever
installed, and bouncing an old shape would drop the report of the user most
likely to be hitting a bug. `tests/smithersBugPayload.test.ts` pins both
shapes, and builds the rc.0 one through `@smthrs/control`'s schemas so a DTO
change fails there rather than in triage.

## Routes

- `POST /api/bugs` — zod-validated report (`{ title, body?, smithersVersion?, platform?, run? }`,
  loose beyond that), 256KB cap (stream-counted, so a missing/spoofed
  content-length can't buffer past the cap), per-IP rate limit of 20/hour via a
  KV counter. The KV counter is **best-effort/advisory** — KV has no atomic
  increment, so a concurrent burst from one IP can race past the limit; use a
  Durable Object or a Rate Limiting binding if a hard cap is ever needed.
  Stores `bug:<id>` and returns `{ id, url }`. No auth: reporting must be
  zero-friction. CORS allows POST from anywhere.
- `GET /api/bugs/:id` — maintainers only; requires the `x-bug-admin` header
  to match the `BUG_ADMIN_TOKEN` binding.
- `GET /healthz`

## Test

```sh
pnpm -C apps/bug-worker test
```

Tests run the real fetch handler against an in-memory KV binding with real
TTL semantics (`tests/helpers/memoryKv.ts`); no route mocking.
`tests/smithersBugPayload.test.ts` is the contract with the CLI's `bug` verb.

## Deploy

Not run by CI. From this directory:

```sh
CLOUDFLARE_API_TOKEN=... ALCHEMY_PASSWORD=... BUG_ADMIN_TOKEN=... \
  pnpm -C apps/bug-worker deploy
```

Optional: `CLOUDFLARE_SMITHERS_ZONE_ID` (zone id for smithers.sh; alchemy
resolves it from the domain when omitted) and `BUG_PUBLIC_BASE_URL`
(defaults to `https://bug.smithers.sh`). See `alchemy.run.ts`.
