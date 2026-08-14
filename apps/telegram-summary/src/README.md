# @smthrs/telegram-summary — src

Source of the Cloudflare Worker behind telegram-summary.smithers.sh.

- `worker.ts` — default export: HTTP routes and cron dispatch, plus the
  constant-time admin bearer check (`timingSafeEqual`).
- `service.ts` — the whole ingest/digest pipeline: Telegram `getUpdates` -> D1
  `messages`, OpenAI GPT-5.6 Luna digest generation with Kimi (Moonshot) as a
  runtime fallback, `sendMessage` post-back, and the
  `status`/`latestDigest`/`listDigests` reads.
- `ui.ts` — self-contained dashboard HTML, the `json`/`notFound` response
  helpers, and `digestPayload` (API shaping for digest rows).
- `schema.ts` — idempotent D1 DDL; `ensureSchema` runs at every entry point.
- `env.ts` — type-only: hand-rolled D1 + env + scheduled-event interfaces. It
  exists instead of `@cloudflare/workers-types` so tests run under plain
  `bun test` (CI has no workerd).

How the pieces fit: `worker.ts` routes HTTP/cron into `service.ts` functions
and renders via `ui.ts`; `service.ts` owns all D1 access and external HTTP.

Gotchas:

- Worker binding names (`TELEGRAM_SOURCE_CHAT_ID`, `DIGEST_WINDOW_HOURS`, ...)
  differ from the deploy-time `TELEGRAM_SUMMARY_*` env vars — `alchemy.run.ts`
  does the mapping. It also supplies the `OPENAI_MODEL` and `KIMI_MODEL`
  defaults that their corresponding constants in `service.ts` must match.
- `OPENAI_API_KEY` is the primary summarizer credential. `MOONSHOT_API_KEY`
  enables only the Kimi runtime fallback used after an unavailable or failed
  OpenAI request.
- Raw ingested messages are stored in D1 but deliberately never exposed by the
  dashboard API.
- Mutation endpoints (`/api/ingest`, `/api/run-digest`) require the
  `ADMIN_TOKEN` bearer.
- The dashboard's inline `<script>` has its own `esc`/`fmt` helpers by design
  (they ship to the browser); do not try to share them with server code.

Smithers itself is not embedded here — the replayable workflow lives at
`.smithers/workflows/telegram-daily-digest.tsx` (see the app-root README).
