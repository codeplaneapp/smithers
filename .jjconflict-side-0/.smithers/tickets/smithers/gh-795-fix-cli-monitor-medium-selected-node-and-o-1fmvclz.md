# 🐛 fix(cli/monitor): [medium] selected node and output remain stale as a run advances

GitHub: https://github.com/smithersai/smithers/issues/795

_via 2026-07 full-codebase audit_

## Summary

The monitor stores the selected TreeNode object itself. Live tree replacements do not rebind that selection, and output is fetched only when stable IDs change.

## Where

- `apps/cli/src/monitor-ui/monitor.tsx:781-813 — full node object is stored`
- `apps/cli/src/monitor-ui/monitor.tsx:593-643 — inspector renders captured object`
- `packages/gateway-react/src/useGatewayNodeOutput.ts:39-50 — unchanged IDs do not refetch output`

## Failure scenario / repro

Select a running node, let it finish and gain tool calls/output. The tree updates but the inspector remains running with no output until deselection/reselection.

## Impact

The primary monitor can show stale status, missing tool calls, and missing durable output for completed work.

## Suggested fix

Store only the stable key and resolve it from the latest tree every render. Invalidate output when the node becomes terminal or a matching output/finish event arrives.

## Tests

- Select a running node, publish a finished replacement and output, and assert the inspector updates without reselection

## Dedupe notes

#701 covers delegation-chain output retry gating, not monitor selection identity.
