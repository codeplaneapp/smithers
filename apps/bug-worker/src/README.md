# @smthrs/bug-worker — src

Cloudflare Worker source for the bug.smithers.sh intake (routes, caps, and
deploy instructions live in `../README.md`).

- `worker.ts` — the fetch handler: permissive CORS, per-IP KV rate limit,
  streamed 256KB body cap (aborts mid-stream, so a lying content-length can't
  buffer the platform cap), timing-safe admin auth for `GET /api/bugs/:id`.
  `createBugWorker(deps)` exists so tests can inject a clock; the default
  export uses `Date.now`.
- `bugReportSchema.ts` — loose zod schema requiring a non-blank `summary` or
  `title` (1 to 500 characters). Accepts current string and 0.x object platform
  values, preserves unknown fields, and stores either envelope without conversion.
- `newBugId.ts` — sortable ulid-ish id (base32 ms timestamp + 16 random chars).
- `env.ts` — `BugWorkerEnv`/`BugKv` binding interfaces; tests satisfy them with
  `tests/helpers/memoryKv.ts`.

The rate limiter is advisory by design (KV has no atomic increment, so
concurrent bursts can race past it); a hard cap needs a Durable Object or a
Cloudflare Rate Limiting binding.
