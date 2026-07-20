# 🐛 vcs: [high] workspaceAdd deletes an existing target before jj validates workspace creation

GitHub: https://github.com/smithersai/smithers/issues/776

_via 2026-07 full-codebase audit_

## Summary

workspaceAdd() recursively deletes an existing target before any jj workspace-add attempt succeeds. If jj is unavailable, rejects the revision, or every fallback fails, the caller gets success:false after unrelated data has already been destroyed.

## Where

- `packages/vcs/src/jj.js:223-242 — recursive rmSync runs during pre-create cleanup`
- `packages/vcs/src/jj.js:243-268 — jj validation happens only after deletion`

## Failure scenario / repro

Seed a target with a sentinel file, force jj to fail, and call workspaceAdd. The operation returns failure but the sentinel and directory are gone. Reproduced on current main.

## Impact

A failed workspace operation can cause irreversible local data loss while presenting itself as an ordinary creation failure.

## Suggested fix

Fail closed when the target exists unless it is positively identified as the stale workspace being replaced. Prefer staging creation and atomic rename, or preserve/restore the prior target on every failure path.

## Tests

- Seed a populated target and use a failing fake jj; assert all contents remain
- Cover invalid revision and spawn failure

## Dedupe notes

No matching issue or PR. Closed audit #303 covers a different jj workspace defect.
