# 🐛 pi-plugin: SmithersPiHttpClient.events() silently swallows non-OK HTTP responses

GitHub: https://github.com/smithersai/smithers/issues/588

**What happens**
`SmithersPiHttpClient.events()` (packages/pi-plugin/src/api/SmithersPiHttpClient.ts:61-63) ends the SSE generator with a bare `return` when `!res.ok || !res.body`. `json()` in the same class (lines 42-53) throws `SmithersError("PI_HTTP_ERROR", ...)` for the same condition.

**Why it's wrong / failure scenario**
A gateway returning 401 (bad/missing API key), 404, or 500 produces a stream that yields nothing and completes cleanly — callers cannot distinguish it from a healthy run with no events, so the failure is invisible (no error, no retry signal, no user-facing message).

**Expected behavior**
Throw `PI_HTTP_ERROR` (with status/path details, matching `json()`) when the response is non-OK or has no body, so stream consumers can surface or retry the failure.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).


> Closed by ticket-fleet: landed on main in 36523d54e4c731ca4b69ab870a249f4c4cd99508.
