# 🔒 fix(cli): [medium] token store rewrites leave permissive tokens.json readable

GitHub: https://github.com/smithersai/smithers/issues/660

via /codex review

**Severity:** Medium

## Problem
`writeSmithersTokenStore()` documents that new token-store files are mode `0600`, but it only passes `{ mode: 0o600 }` to `writeFileSync`. Node applies that mode only when creating a file; it does not repair permissions on an existing `tokens.json`. If the file already exists as `0644` or another permissive mode, every later rewrite preserves the readable mode while storing bearer secrets in plaintext.

## References
- `apps/cli/src/token-store.js:168` says the helper persists the store and creates new files mode `0600`.
- `apps/cli/src/token-store.js:173` defines `writeSmithersTokenStore()`.
- `apps/cli/src/token-store.js:176` writes the JSON with `{ mode: 0o600 }`, but never calls `chmodSync` or writes via a secured replacement path.
- `apps/cli/src/token-store.js:221` stores the raw bearer token as `grant.secret`.
- `apps/cli/tests/token-store.test.js:37` covers round-trip persistence but does not assert permission repair for an existing file.

## Failure Scenario
1. A prior version, manual copy, or deployment volume creates `~/.smithers/tokens.json` with mode `0644`.
2. The operator runs `smithers token issue` or any code path that calls `writeSmithersTokenStore()`.
3. The file contents now include bearer grants and action tokens, but the file remains `0644`.

Verified locally with a temp file:

```text
writeFileSync(tokens.json, "{}\n", { mode: 0o644 })
writeSmithersTokenStore({ version: 2, tokens: { secret: { role: "operator", scopes: ["*"], secret: "secret" } }, actionTokens: {}, audit: [] })
stat(tokens.json).mode & 0o777 === 0o644
```

## Why It Matters
Gateway bearer tokens are full control-plane credentials; many grants use `scopes: ["*"]`. A permissive token store leaks those credentials to other local users, backup jobs, or mounted-volume readers. The code gives the impression that writes secure the store, but existing permissive files remain permissive indefinitely.

A safer implementation should enforce `0600` on every successful write, preferably with an atomic temp-file replacement that creates the temp file `0600` and verifies/chmods the final path.

