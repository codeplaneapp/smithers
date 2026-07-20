# 🐛 cli/token-store: [medium] non-atomic writeFileSync on tokens.json — a torn write silently wipes every bearer grant

GitHub: https://github.com/smithersai/smithers/issues/743

_via ultracode (Opus multi-agent) review_

## Summary
`writeSmithersTokenStore()` overwrites the security-critical `~/.smithers/tokens.json` with a bare in-place `writeFileSync` (O_TRUNC + write), not the tmp-file+rename atomic pattern the sibling module already uses. An interrupted write corrupts the file, and the reader silently falls back to an empty store — losing every gateway bearer grant and action token.

## Locations
- `apps/cli/src/token-store.js:173-177` — `writeSmithersTokenStore()` does `writeFileSync(path, JSON, { mode: 0o600 })` in place; no tmp+rename.
- `apps/cli/src/token-store.js:159-165` — `readSmithersTokenStore()` catches any `JSON.parse` failure and returns `defaultStore()` (empty).
- `apps/cli/src/token-store.js:340-345` — `resolveSmithersActionTokenFromStore()` rewrites the *entire* file on every successful resolve.
- Callers are separate short-lived processes: `apps/cli/src/index.js:4177/4184` (issue), `:4213` (resolve/exec), `:4254/4264` (revoke) — each an unsynchronized read-modify-write of the whole file.
- Contrast: `apps/cli/src/gateway-runtime.js:256-261` (`writeGatewayRuntimeState`) writes to `${stateFile}.${pid}.tmp` then `renameSync`, with an explicit atomicity comment (lines 248-249) precisely because that state file "may carry the gateway bearer token".

## Failure scenario
A crash, SIGKILL, ENOSPC, or a concurrent second smithers process interrupting the `writeFileSync` leaves `tokens.json` truncated/half-written. On the next load, `JSON.parse` throws, `readSmithersTokenStore()` swallows it and returns an empty store — so every previously issued bearer grant and action token vanishes and all gateway auth built on them fails, with no error surfaced. Two overlapping processes (e.g. `smithers token exec` resolving while `smithers token issue` mints) also lose one side's writes entirely (last-writer-wins over the whole file).

## Why it matters
`tokens.json` is the local root of gateway trust. A torn or clobbered write is a durability and availability failure for authenticated gateway access. The fix is exactly what the adjacent module already does: write to `${path}.tmp` (pid-scoped) then `renameSync` into place.
