# 🐛 graph(Approval): [medium] malformed allowedUsers/allowedScopes restrictions fail open

GitHub: https://github.com/smithersai/smithers/issues/782

_via 2026-07 full-codebase audit_

## Summary

Approval restrictions that are not non-empty string arrays are silently dropped. Durable approval JSON then stores empty arrays, and the gateway interprets those as unrestricted.

## Where

- `packages/components/src/components/Approval.js:164-169,205-218 — runtime values are forwarded without validation`
- `packages/graph/src/extract.js:174-179,686-698 — malformed values become undefined`
- `packages/engine/src/effect/deferred-state-bridge.js:72-85 — missing values become empty arrays`
- `packages/server/src/gateway.js:7010-7017 — empty arrays skip authorization gates`

## Failure scenario / repro

A JS/generated workflow passes allowedUsers="user:will" or allowedUsers={[42]}. Extraction drops it, the stored request contains [], and any otherwise-authorized connection can decide the approval.

## Impact

A configuration or type mistake weakens an authorization boundary instead of failing closed.

## Suggested fix

Validate at component/extraction time and reject anything other than arrays of non-empty strings. Do not partially filter malformed arrays; validate durable requests again before decision.

## Tests

- Cover scalar, mixed, empty-string, and valid arrays
- Assert malformed durable restrictions cannot be decided

## Dedupe notes

#552 covers valid but unknown scopes degrading elsewhere; it does not cover malformed restrictions disappearing.
