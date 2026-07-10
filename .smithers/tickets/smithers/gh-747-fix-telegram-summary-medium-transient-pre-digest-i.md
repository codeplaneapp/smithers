# 🐛 fix(telegram-summary): [medium] transient pre-digest ingest failure drops the whole daily digest

GitHub: https://github.com/smithersai/smithers/issues/747

_via ultracode (Opus multi-agent) review_

**Summary:** An unguarded `await ingestTelegramUpdates(env)` before `runDailyDigest` in the digest cron path lets a momentary Telegram API hiccup skip the entire day's digest.

**Location:**
- `apps/telegram-summary/src/worker.ts:74` — digest branch: `await ingestTelegramUpdates(env)` then `await runDailyDigest(...)`, no guard around the ingest.
- `apps/telegram-summary/src/service.ts:287` — `telegramCall` invoked in the ingest loop with no try/catch.
- `apps/telegram-summary/src/service.ts:218-219` — `telegramCall` throws on `!response.ok || !parsed.ok`; the `fetch`/`response.json()` (lines 212, 217) can also reject.
- `apps/telegram-summary/src/worker.ts:86` — `ctx.waitUntil(scheduledHandler(...))`; a rejection here is not retried.

**Failure scenario:** At the DIGEST_CRON minute, Telegram `getUpdates` transiently returns HTTP 429/5xx (or the fetch rejects). `telegramCall` throws, the throw bubbles out of `scheduledHandler` before line 75, and `runDailyDigest` is never called. No digest is generated or posted that day.

**Why it matters:** The core daily deliverable is coupled to an optional best-effort refresh. `runDailyDigest` (service.ts:572-635) already reads previously-ingested D1 rows and is fully guarded (own try/catch; `postDigest` swallows send errors), and the 15-min ingest cron has already stored the day's messages — so the digest does not need this fresh ingest to succeed. Wrap the pre-digest ingest in try/catch (log/warn on failure) so `runDailyDigest` still runs against already-ingested data.
