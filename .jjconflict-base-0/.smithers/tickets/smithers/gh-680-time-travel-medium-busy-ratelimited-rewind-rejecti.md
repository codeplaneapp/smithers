# 🐛 time-travel: [medium] Busy/RateLimited rewind rejections write a terminal "failed" audit instead of retrying

GitHub: https://github.com/smithersai/smithers/issues/680

_via ultracode (Opus multi-agent) review_

**Summary:** Pre-work rewind rejections (Busy, RateLimited) persist a terminal `result='failed'` audit row that counts toward the caller's rewind quota, turning the rate limiter into a self-reinforcing lockout.

**Locations:**
- `packages/time-travel/src/jumpToFrame.js:535` — `canWriteAudit = true` is set BEFORE the single-flight lock acquisition (Busy throw at `:543`) and BEFORE the rate-limit check (RateLimited throw at `:561`).
- `packages/time-travel/src/jumpToFrame.js:571` — `auditRowId` is only assigned after both checks, so on a Busy/RateLimited throw `auditRowId===null` while `canWriteAudit===true`.
- `packages/time-travel/src/jumpToFrame.js:1019-1030` — the `finally` `else if (canWriteAudit)` branch writes a new row with `result: auditResult` (defaults to `"failed"`, `:476`) and `timestampMs: startedAtMs` (now).
- `packages/time-travel/src/countRecentRewindAuditRows.js:18-24` — counts every row `WHERE result <> 'in_progress'` and `timestamp_ms >= sinceMs`; no distinct "rejected" result exists, so `failed` rejection rows are counted.
- `packages/time-travel/src/evaluateRewindRateLimit.js:27-34` — `limited = used >= max` over the rolling window.

**Failure scenario:** A `(run, caller)` reaches `max` (default 10) rewinds within the window. The caller (or a UI/agent auto-retrying on RateLimited) retries; each rejected attempt inserts a fresh `result='failed'` row with `timestamp_ms=now`. Because those rows fall inside the trailing window and are counted, `used` never drops below `max` while retries continue — an indefinite lockout rather than a bounded one-window cooldown. Separately, a double-clicked rewind burns a quota slot via a Busy-rejected row that mutated nothing.

**Why it matters:** Recording rejected attempts for auditability is fine, but counting them toward the quota makes the limiter self-perpetuating and pollutes `listRewindAuditRows` with phantom `failed` rewinds (`fromFrameNo=-1`) that never mutated state. Pre-work rejections should be excluded from the rate-limit count — e.g. a distinct result value that `countRecentRewindAuditRows` ignores, or not writing a terminal `failed` row for rejections thrown before the `in_progress` write.
