# 🐛 fix(cli/local-ui): [medium] file saves overwrite concurrent edits and can tear workspace files

GitHub: https://github.com/smithersai/smithers/issues/797

_via 2026-07 full-codebase audit_

## Summary

The local file API returns mtimeMs on read, but writes do not validate an expected revision. It also truncates/writes the target directly rather than using atomic replacement.

## Where

- `apps/cli/src/localUiServer.js:831-883 — reads return mtimeMs`
- `apps/cli/src/localUiServer.js:900-938 — no optimistic concurrency check; direct writeFileSync`
- `apps/cli/src/localUiServer.js:977-985 — write request includes only path/content`

## Failure scenario / repro

The UI reads revision A, another editor writes B, then the stale UI save silently overwrites B. Process or I/O failure during direct write can also leave a partial file.

## Impact

The editor can destroy concurrent user/agent work or corrupt the only on-disk source copy.

## Suggested fix

Require expected mtime/hash and return 409 on mismatch. Write to a same-directory temporary file and atomically rename, preserving relevant mode bits.

## Tests

- Two readers: the second stale save gets 409 and preserves newer content
- Simulated write failure leaves the original intact
- Successful save returns a new revision

## Dedupe notes

#743 is token-store atomicity and #751 is DNS rebinding, not workspace editor concurrency.
