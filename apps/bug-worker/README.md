# bug-worker

Cloudflare Worker behind `https://bug.smithers.sh` that receives bug reports
from `smithers bug` (and anyone else) and stores them in KV. Part of the
post-failure autopsy feature — see `.smithers/specs/post-failure-autopsy.md`.

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
TTL semantics (`tests/helpers/memoryKv.ts`) — no route mocking.

## Deploy

Not run by CI. From this directory:

```sh
CLOUDFLARE_API_TOKEN=... ALCHEMY_PASSWORD=... BUG_ADMIN_TOKEN=... \
  pnpm -C apps/bug-worker deploy
```

Optional: `CLOUDFLARE_SMITHERS_ZONE_ID` (zone id for smithers.sh; alchemy
resolves it from the domain when omitted) and `BUG_PUBLIC_BASE_URL`
(defaults to `https://bug.smithers.sh`). See `alchemy.run.ts`.
