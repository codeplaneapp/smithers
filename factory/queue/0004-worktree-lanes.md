---
status: queued
anchor: head
priority: p1
---

# Worktree lanes and the merge queue in the Jj service

Implement the lane lifecycle from the "Worktree Lanes" spec in `packages/smithers/flows/jj`
(and the engine seams it names): the note is currently all
"Proposed" and `packages/smithers/flows/jj` ships no lane operations.

- `Jj.createLane(descriptor)` with the identity/ownership checks the note
  specifies; creation serialized per repository.
- Lane checkpoints (tool boundary + debounced watch), restore ordering, and
  the NDJSON gap spool, inherited from the smithers prior art the note cites.
- The merge queue: serialized `Jj.land` critical section with the captured
  target-revision and lane-digest proofs; `halt` default policy.
- `Jj.releaseLane` with the four conservative keep-checks; never automatic.
- Browser obligation per the "Browser jj" spec: OPFS-backed equivalent or a
  ticket, never a silent exception.
- This unblocks the factory flow's implement/land phases (item 0003) and
  narrative-anchor lanes (the "Clean History" spec).
- Follow the vault cadence: this is a reviewed piece; land the design deltas
  in the note (Proposed → decided, with how) alongside the code.
