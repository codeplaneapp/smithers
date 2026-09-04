---
status: queued
anchor: head
priority: p1
---

# Retell main as the documented clean series

Perform the first full retell described in the "Clean History" spec: rebuild
`main` from an empty root as an ordered series of clean commits that documents
the implementation of the entire repo ahead of the code.

- Series order: the spec vault first, then per package a docs commit
  (README + JSDoc, per the "Colocated Docs" spec) followed by that package's
  implementation commits, then the tests that pin behavior.
- Every narrative commit description carries trailers naming the `vibe`
  change-ids it was folded from.
- End state must pass the tree-equality gate: `jj diff --from main --to vibe`
  is empty.
- `vibe` is untouched; it keeps the real history.
- Do not start until item 0002's parity gate exists, so the docs commits in
  the series are gated, not aspirational.
