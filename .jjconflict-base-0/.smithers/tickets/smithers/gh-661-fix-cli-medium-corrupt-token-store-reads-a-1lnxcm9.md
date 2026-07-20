# 🐛 fix(cli): [medium] corrupt token store reads allow later writes to clobber grants

GitHub: https://github.com/smithersai/smithers/issues/661

via /codex review

**Severity:** Medium

## Problem
A malformed `tokens.json` is treated as an empty store, and the next normal write overwrites the corrupt file with only the newly-mutated empty store. Because `writeSmithersTokenStore()` writes directly to the target path, a crash, interrupted write, or manual truncation can permanently drop all existing bearer grants/action handles on the next token command instead of failing closed and preserving the damaged file for recovery.

## References
- `apps/cli/src/token-store.js:148` documents loading the on-disk token store.
- `apps/cli/src/token-store.js:159` parses `tokens.json`.
- `apps/cli/src/token-store.js:163` catches every read/parse failure.
- `apps/cli/src/token-store.js:164` returns a default empty store for corrupt JSON.
- `apps/cli/src/token-store.js:173` defines `writeSmithersTokenStore()`.
- `apps/cli/src/token-store.js:176` writes directly to the token-store path.
- `apps/cli/src/token-store.js:224` starts from the caller's store when issuing a new grant.
- `apps/cli/src/token-store.js:226` adds only the new token before the store is later persisted.
- `apps/cli/tests/token-store-coverage.test.js:91` currently pins the corrupt-file read as an empty store, but there is no guard preventing a later write from clobbering the recoverable file.

## Failure Scenario
1. Existing `tokens.json` contains an operator token `smithers_existing_secret`.
2. The file is truncated mid-write and now contains invalid JSON.
3. `readSmithersTokenStore()` returns `{ tokens: {}, actionTokens: {}, audit: [] }`.
4. `smithers token issue` issues `smithers_new_secret` into that empty in-memory store.
5. `writeSmithersTokenStore()` overwrites `tokens.json` directly.

Verified locally:

```text
tokens after corrupt read 0
file contains existing? false
file contains new? true
```

## Why It Matters
This is both a durability and operator-access hazard. A transient partial write can silently revoke every previously issued Gateway token and action handle, and the original bytes are lost when the next command writes the defaulted store. The accounts registry already treats corrupt live state as something to preserve and fail closed; the token store should avoid clobbering recoverable credential state.

A safer implementation would fail writes when the existing store is corrupt unless the operator explicitly resets it, and write through a mode-0600 temp file plus atomic rename/fsync so partial writes do not corrupt the live store.

