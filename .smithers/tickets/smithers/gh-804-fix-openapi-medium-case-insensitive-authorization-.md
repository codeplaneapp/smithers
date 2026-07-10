# 🔒 fix(openapi): [medium] case-insensitive Authorization collisions combine model and operator credentials

GitHub: https://github.com/smithersai/smithers/issues/804

_via 2026-07 full-codebase audit_

## Summary

OpenAPI headers are merged in a case-sensitive object. Model-controlled authorization does not collide with operator-injected Authorization; Headers later normalizes and combines both values.

## Where

- `packages/openapi/src/tool-factory/_helpers.js:182-230`

## Failure scenario / repro

An operation declared lowercase authorization. The model supplied Bearer ATTACKER while configuration supplied Bearer REAL; a real server received both as one combined header.

## Impact

Servers and proxies differ on first/last/combined credential handling, causing authentication confusion and possible bypass.

## Suggested fix

Merge headers case-insensitively. Reserve configured auth/header names before accepting operation parameters and discard or reject every case variant.

## Tests

- Exercise every casing of Authorization and configured API-key header names
- Assert exactly one operator-controlled value reaches the server

## Dedupe notes

No matching issue or open PR.
