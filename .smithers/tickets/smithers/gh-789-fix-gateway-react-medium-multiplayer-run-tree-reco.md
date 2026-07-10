# 🐛 fix(gateway-react): [medium] multiplayer run-tree reconstruction drops every sibling node

GitHub: https://github.com/smithersai/smithers/issues/789

_via 2026-07 full-codebase audit_

## Summary

The multiplayer node shape contains no hierarchy. Its mapper emits childIds:[], and the tree builder selects one root, making every other independent node unreachable.

## Where

- `packages/db/src/internal-schema/smithersNodes.js:2-12 — no parent/child linkage`
- `packages/gateway-client/src/data/mapSmithersElectricRow.ts:98-118 — childIds is always empty`
- `packages/gateway-react/src/sync/buildGatewayRunTree.ts:9-24 — only the first root is traversed`

## Failure scenario / repro

Seed two task rows for one run. Both map as roots, but buildGatewayRunTree returns only the first task.

## Impact

Multiplayer UI drops ordinary sibling tasks, nesting, parallel branches, retries, and loop attempts.

## Suggested fix

Persist or derive a durable parent/ordered-child key, or reconstruct from durable frame snapshots. Preserve forests beneath a synthetic run root instead of discarding roots.

## Tests

- Two siblings both appear
- Nested and parallel structure is preserved
- Local and multiplayer trees are structurally equivalent

## Dedupe notes

#626 and #737 concern different rendering/snapshot behavior.
