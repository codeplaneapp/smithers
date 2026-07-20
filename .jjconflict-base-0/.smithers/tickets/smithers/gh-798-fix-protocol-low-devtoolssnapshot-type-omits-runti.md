# 🐛 fix(protocol): [low] DevToolsSnapshot type omits runtime runState

GitHub: https://github.com/smithersai/smithers/issues/798

_via 2026-07 full-codebase audit_

## Summary

The DevTools snapshot route conditionally includes runState, but the exported protocol type does not declare it.

## Where

- `packages/protocol/src/devtools/DevToolsSnapshot.ts:3-9 — runState omitted`
- `packages/server/src/gatewayRoutes/getDevToolsSnapshot.js:442-478 — route returns runState`

## Failure scenario / repro

A TypeScript consumer receives runtime JSON containing runState, but snapshot.runState fails type checking and requires an undocumented cast.

## Impact

Published types hide supported stale/orphaned/blocked state and encourage downstream duplicate declarations.

## Suggested fix

Add an optional shared runState shape to DevToolsSnapshot without violating package boundaries.

## Tests

- Add a compile-time consumer contract accessing optional runState
- Assert zero-frame and normal route responses satisfy the type

## Dedupe notes

No existing issue covers this protocol/runtime mismatch.
