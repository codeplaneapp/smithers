# factory/queue/

The intake of the software factory. One markdown file per requested change;
presence is registration. The design is in the spec vault, a separate
repository: the "Software Factory" spec (process), the "Clean History" spec
(the `vibe`/`main` branch model), and the "Colocated Docs" spec (documentation
planes).

## Item format

```markdown
---
status: queued          # queued | in-progress | landed | retold | blocked
anchor: narrative       # narrative | head
priority: p1            # p0 | p1 | p2
---

The prompt: what to change and why, in plain prose.
```

- `anchor: narrative` bases the work lane on the commit in `main`'s retold
  series that owns the affected subsystem; the retell folds the change into
  that span. `anchor: head` bases on the tip and defers the fold.
- The item's digest keys its run. Editing an item re-keys exactly its own
  work; re-running a processed item is a cache hit.
- Processing order: docs → gate → implement → verify → land on `vibe` →
  retell into `main`. The docs phase holds writes to `docs/**` and package
  READMEs only; the implement phase holds code writes; the retell holds
  `vcs:write`.

## Operating it today

Until the factory flow ships (item 0003), the operator is the local smithers
workflow `queue-driver` (`.smithers/workflows/queue-driver.tsx`, UI at
`.smithers/ui/queue-driver.tsx`; both untracked). Run it from the repo root:

```sh
smithers workflow run queue-driver                                # highest-priority queued item
smithers workflow run queue-driver --input '{"item":"<slug>"}'    # a specific item
```

`--input` takes an inline JSON value. Pass
`--input '{"requireApproval":true}'` to add a human approval gate before
landing. One run processes one item: pick flips its `status` to
`in-progress`, then docs → implement → verify → land run in an isolated
worktree lane (`.smithers/workflows/.worktrees/queue-<slug>`, branch
`queue/<slug>`, based on `main`). Land rebases the lane onto `origin/main`
and pushes `main` only while `vibe` is parked; a final wrap step flips the
item's `status` to `landed` or `blocked` and pushes that bookkeeping commit.
The workflow owns the `status` field; do not edit it by hand while a run is
active.
