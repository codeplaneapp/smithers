---
status: landed
anchor: head
priority: p2
---

# Document the queue-driver operator

Docs-only item (also the queue driver's smoke test). The interim operator
now exists as the untracked local workflow
`.smithers/workflows/queue-driver.tsx` (UI at `.smithers/ui/queue-driver.tsx`):
pick → docs → implement → verify → land in an isolated worktree lane, landing
on `main`+`vibe` together.

- Update the "Cutover, honestly" section of the "Software Factory" spec in the
  spec vault to name the queue-driver workflow as the operator implementation
  that drives the queue until the Smithers-native factory flow (item 0003)
  ships.
- Update `factory/queue/README.md`'s "Operating it today" section to say: run
  `smithers workflow run queue-driver` (optionally
  `--input '{"item":"<slug>"}'`) instead of the hand-driven DDD pack
  instructions.
- No source-code changes. The implement phase should report no code needed;
  the verify phase checks the docs match the workflow's real behavior.

## Landed

Smoke run `run-1786694787510` (2026-08-14) processed this item end to end:
pick → docs → implement → verify → land in lane `queue/0005-document-queue-driver`,
landing `3545735` on `main` (fast-forward, lane branch deleted, `vibe`
untouched). The verify phase withheld approval over two doc-vs-behavior
mismatches it reproduced — the documented `--input item=<slug>` syntax fails
(smithers `--input` takes inline JSON) and the wrap step still moved `vibe` —
both fixed immediately after the run: docs corrected to
`--input '{"item":"<slug>"}'` in `factory/queue/README.md` (then `queue/README.md`) and the vault note, and
the workflow's wrap step rewritten to commit the status flip via a temporary
git index and push `main` only. This item prescribed the wrong `--input`
syntax itself; the pipeline caught its own spec bug on the first pass.
