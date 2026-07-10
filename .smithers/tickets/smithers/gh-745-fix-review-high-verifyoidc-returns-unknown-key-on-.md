# 🐛 fix(review): [high] verifyOidc returns unknown-key on JWKS kid miss without refreshing the 10-min cache → GitHub OIDC key rotation can 401 valid CI sessions

GitHub: https://github.com/smithersai/smithers/issues/745

_via ultracode (Opus multi-agent) review_

**Summary:** On a JWKS `kid` miss, `verifyOidc` fails closed with `unknown-key` instead of forcing a one-time JWKS refetch, so a warm worker's stale 10-min cache rejects tokens signed by a newly-rotated GitHub OIDC key until the TTL expires.

**Locations:**
- `apps/review/src/server/sessions/verifyOidc.ts:105-107` — `keys.find(k => k.kid === header.kid)`; on `undefined` returns `{ ok:false, reason:"unknown-key" }` with no refetch.
- `apps/review/src/server/sessions/fetchJwks.ts:3,24-33` — fixed `CACHE_TTL_MS = 10*60*1000`, refetches only after TTL.
- `apps/review/src/server/sessions/jwksCache.ts:12` — module-scoped `Map`, so the stale entry persists across requests for the worker's lifetime.
- `apps/review/src/server/sessions/handleSessions.ts:93-94` — maps the failure to `401 oidc: unknown-key`, the sole OIDC gate for CI-issued review sessions.

**Failure scenario:** GitHub adds a new OIDC signing key to its JWKS at T0 and signs new tokens with it. A worker whose cache was populated before T0 lacks the new `kid`. From T0 until the cache's 10-min TTL expires, every `POST /api/sessions` carrying a token signed by the new key hits `keys.find() === undefined` and returns `401 oidc: unknown-key`, even though the token is valid — blocking reviews for affected repos during the window, and self-healing only silently after the TTL.

**Why it matters:** This is the single auth gate for every CI-issued review. Refresh-on-miss (refetch once on `kid` miss, re-check, with a short cooldown to avoid stampede) is the well-known mitigation and is absent; a routine upstream key rotation degrades into a hard-to-diagnose, TTL-bounded auth outage. Impact is bounded to the TTL window and depends on GitHub's rotation/pre-publish timing, hence medium severity.
