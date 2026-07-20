# 🐛 fix(review): [medium] transient JWKS fetch failure throws uncaught → opaque 500 instead of a tagged session-mint error

GitHub: https://github.com/smithersai/smithers/issues/744

_via ultracode (Opus multi-agent) review_

**Summary:** A transient JWKS fetch failure during OIDC verification escapes as an unhandled throw all the way out of the worker's `fetch` handler, producing a bare 500 with no JSON body — unlike every other OIDC failure, which maps to a specific status.

**References:**
- `apps/review/src/server/sessions/fetchJwks.ts:26-28` — `await fetchImpl(url)` propagates network rejections; `throw new Error(...)` on any non-2xx. No internal catch, and the cache (lines 24-25) only shields on a fresh hit (10-min TTL).
- `apps/review/src/server/sessions/verifyOidc.ts:105` — `await fetchJwks(...)` with no try/catch. This is the only throwing path in a function whose docstring (lines 87-89) promises "Returns a tagged result instead of throwing"; every other failure returns `{ ok:false, reason }` (lines 98, 102, 103, 107, 118, 120-131).
- `apps/review/src/server/sessions/handleSessions.ts:93` — calls `verifyOidc` bare; its only try/catch (82-86) wraps `request.json()`.
- `apps/review/src/server/worker.ts` — top-level `fetch` handler has no surrounding error boundary around `handleSessions`.

**Failure scenario:** GitHub's `token.actions.githubusercontent.com` JWKS endpoint returns a transient 503 (or the fetch times out) while the cache entry is stale/absent (cold start or post-TTL). `fetchJwks` throws `jwks fetch ... returned 503`; nothing in the chain catches it; an unhandled throw from a Workers `fetch` handler yields a generic 500 with no JSON error body. The review GitHub Action receives an undifferentiated 500 rather than a clean, retryable 401/503, and cannot distinguish a transient upstream blip from a hard auth failure.

**Why it matters:** For a durable control plane whose job is graceful degradation, the most common transient failure (upstream 5xx / network) is the single OIDC path with no error boundary. `handleSessions` documents a 400/401/402/403 contract that this path silently breaks. Fix: convert JWKS fetch/non-2xx failures into a tagged retryable reason (e.g. `jwks-unavailable`) in `verifyOidc`, mapped to 503 in `handleSessions`; optionally add a catch-all boundary in `worker.fetch`.
