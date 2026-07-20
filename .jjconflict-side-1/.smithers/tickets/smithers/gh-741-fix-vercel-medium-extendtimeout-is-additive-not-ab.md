# 🐛 fix(vercel): [medium] extendTimeout is additive, not absolute — sandbox overshoots plan cap by createTimeoutMs

GitHub: https://github.com/smithersai/smithers/issues/741

_via ultracode (Opus multi-agent) review_

## Summary
`createVercelSandboxProvider` reaches durations beyond the 5-min create ceiling by calling `sandbox.extendTimeout(desiredMs)`, but the real `@vercel/sandbox` `extendTimeout(duration)` extends the lifetime **BY** `duration`, not to an absolute total. The sandbox is provisioned for `createTimeoutMs + desiredMs`, always ~5 min over — defeating the `maxDurationMs` plan/billing cap.

## Evidence
- `packages/vercel/src/createVercelSandboxProvider.js:62` — `createTimeoutMs = Math.min(desiredMs, DEFAULT_SESSION_TIMEOUT_MS)` (5 min); sandbox created with `timeout: createTimeoutMs` (line 74).
- `packages/vercel/src/createVercelSandboxProvider.js:106` — `await sandbox.extendTimeout(desiredMs)` (passes the absolute target as if it were the total).
- `packages/vercel/node_modules/@vercel/sandbox/dist/sandbox.d.ts:857-874` — "Extend the timeout of the sandbox **by** the specified duration … `@param duration - The duration in milliseconds to extend the timeout by`"; example: create `ms('10m')` + `extendTimeout(ms('5m'))` → "a total of 15 minutes." Same contract in `session.d.ts:395-413`.
- Constants: `DEFAULT_SESSION_TIMEOUT_MS=5min` (line 10), `DEFAULT_MAX_DURATION_MS=45min` (line 12).

## Failure scenario
`createVercelSandboxProvider({ timeoutMs: 45*60_000 })` — exactly at the default 45-min cap.
- `desiredMs=45min` passes the `desiredMs > maxDurationMs` guard (line 55; 45min is not > 45min).
- `createTimeoutMs = min(45min, 5min) = 5min`; create with `timeout=5min`.
- `desiredMs(45min) > createTimeoutMs(5min)` → `extendTimeout(45min)`.
- Real total lifetime = 5min + 45min = **50min**, 5 minutes past the configured plan cap.
- If 50min exceeds the account plan maximum, the SDK rejects `extendTimeout` ("up until the maximum execution timeout for your plan"), the setup `catch` at line 123 destroys the sandbox, and the run fails with `SANDBOX_EXECUTION_FAILED` — a request legitimately within the configured cap hard-fails.

## Why it matters
Every long-lived Vercel sandbox runs ~5 min over budget (silent billing/plan-cap violation), and requests exactly at the cap can be rejected outright.

## Fix
```js
await sandbox.extendTimeout(desiredMs - createTimeoutMs);
```
Note: the existing test `packages/vercel/tests/createVercelSandboxProvider.test.js:355` expects `extendTimeoutCalls == [10*60_000]`, enshrining the wrong absolute value — it passes only because the mock records the raw argument rather than modeling the additive SDK semantics. Update it to expect `desiredMs - createTimeoutMs` (and likewise line 381).
