# 🐛 react-reconciler: [medium] out-of-order DevTools teardown resurrects a stopped handler

GitHub: https://github.com/smithersai/smithers/issues/783

_via 2026-07 full-codebase audit_

## Summary

Multiple SmithersDevTools instances wrap global React DevTools handlers, but cleanup restores each instance's captured predecessor. Stopping instances out of LIFO order can reinstall a handler owned by an already-stopped instance.

## Where

- `packages/react-reconciler/src/devtools/SmithersDevTools.js:228-265 — start captures and wraps current handlers`
- `packages/react-reconciler/src/devtools/SmithersDevTools.js:266-294 — stop restores a raw captured handler`

## Failure scenario / repro

Start A, start B, stop A, then stop B. B restores A's handler even though A is stopped; the original pre-Smithers handler is not restored.

## Impact

Stopped instances continue receiving commits, retain state/listeners, and can duplicate or misroute snapshots.

## Suggested fix

Use a shared active registration stack with a stable dispatcher, or unlink stopped wrappers from the chain and restore the newest still-active predecessor.

## Tests

- Cover A/B teardown in both orders and three-instance permutations
- After all stop, assert original handlers are restored and stopped cores cannot be reached

## Dedupe notes

#737 and #733 concern different DevTools snapshot/unmount defects.
