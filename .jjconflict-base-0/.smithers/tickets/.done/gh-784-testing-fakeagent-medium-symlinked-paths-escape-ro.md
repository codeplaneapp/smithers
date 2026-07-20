# 🐛 testing(fakeAgent): [medium] symlinked paths escape rootDir containment

GitHub: https://github.com/smithersai/smithers/issues/784

_via 2026-07 full-codebase audit_

## Summary

fakeAgent checks file paths lexically but does not account for symlinks already present under rootDir. A relative declared path can follow such a symlink and write outside the promised workspace boundary.

## Where

- `packages/testing/src/fakeAgent.ts:134-151 — containment is lexical`
- `packages/testing/src/fakeAgent.ts:153-155 — mkdir/writeFile follows existing symlinks`

## Failure scenario / repro

Create root/link as a symlink to a sibling outside directory, then declare files:{"link/escaped.txt":"escaped"}. fakeAgent succeeds and writes outside rootDir.

## Impact

Tests and workflow simulations can overwrite adjacent user or checkout state and are not hermetic.

## Suggested fix

Resolve and verify each existing ancestor under the real root, reject symlink components, and use no-follow/openat-style semantics where supported. Recheck after directory creation.

## Tests

- Cover a symlinked-directory escape and symlink final-file case
- Assert ordinary nested relative writes still work

## Dedupe notes

#729 and #728 are different fakeAgent/simulation defects.


> Closed by ticket-fleet: landed on main in 792bb5bf602ba04ad359e3ce5b7d3e16f2284f46.
