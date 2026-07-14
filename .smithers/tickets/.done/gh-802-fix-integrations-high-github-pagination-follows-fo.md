# 🔒 fix(integrations): [high] GitHub pagination follows foreign Link URLs with the repository token

GitHub: https://github.com/smithersai/smithers/issues/802

_via 2026-07 full-codebase audit_

## Summary

GitHubClient accepts absolute request URLs and trusts absolute Link rel=next targets. Every request receives the configured bearer token regardless of destination origin.

## Where

- `packages/integrations/src/github/GitHubClient.js:124-131 — absolute URL acceptance`
- `packages/integrations/src/github/GitHubClient.js:141-159 — token attachment`
- `packages/integrations/src/github/GitHubClient.js:225-243 — pagination following`

## Failure scenario / repro

A real local API returned a foreign absolute Link target. paginate() fetched it and the second server received Authorization:Bearer gh-secret. Direct absolute request URLs reach the same path.

## Impact

A compromised enterprise endpoint, proxy, fixture, or malformed response can exfiltrate a repository token.

## Suggested fix

Require request and pagination URLs to match the configured HTTP(S) API origin. Prefer relative paths and never attach GitHub credentials to foreign destinations.

## Tests

- Reject direct foreign absolute URLs without contacting them
- Reject foreign pagination links
- Preserve same-origin pagination

## Dedupe notes

No matching issue or open PR.


> Closed by ticket-fleet: landed on main in 06adbb2df3bee35f68f1ca27f24a0718e50672e9.
