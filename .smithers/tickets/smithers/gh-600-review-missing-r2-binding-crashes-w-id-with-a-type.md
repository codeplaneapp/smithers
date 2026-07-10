# 🐛 review: missing R2 binding crashes /w/<id> with a TypeError instead of a clean 503

GitHub: https://github.com/smithersai/smithers/issues/600

**What happens**
`apps/review/src/server/worker.ts:69` — the `GET /w/<id>` route calls `env.WALKTHROUGHS.get(...)` unguarded. The router guards `env.DB` (`worker.ts:82`, "a missing binding is a deploy/config problem — answer 503"), but has no equivalent check for the `WALKTHROUGHS` R2 binding. `handleWalkthroughs` POST has the same exposure via `env.WALKTHROUGHS.put`.

**Why it's wrong / failure scenario**
A misconfigured deploy (R2 binding renamed/omitted in wrangler config) makes every walkthrough read/publish crash with `TypeError: Cannot read properties of undefined` — an opaque 500 in Workers logs — while the same failure class on D1 returns a diagnosable 503 "database unavailable". Inconsistent handling of the identical config-error class.

**Expected behavior**
`if (!env.WALKTHROUGHS) return jsonError(503, "walkthrough storage unavailable")` (or equivalent) before the `/w/` route and in the publish path, mirroring the DB guard.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
