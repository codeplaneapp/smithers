---
status: queued
anchor: head
priority: p1
---

# The factory flow

Implement the queue processor from `docs/specs/Concepts/Software Factory.md`
as flows and Actions (`docs/specs/Concepts/Unified Flow Authoring.md`),
replacing the smithers DDD pack as this repo's operator.

- A trigger door over `factory/queue/`: item files decode through one
  schema; the
  item digest keys the run.
- Phases as steps with kernel-enforced envelopes: docs (writes `docs/**` and
  package READMEs only) → gate (vault check + docs parity) → implement (lane
  based at the item's anchor, per `docs/specs/Concepts/Worktree Lanes.md`) →
  verify (affected smithers build targets) → land (merge queue onto `vibe`) →
  retell (fold into `main`, tree-equality gate).
- The retell step is the cutover point described in the Clean History note
  (`docs/specs/Concepts/Clean History.md`): when it ships, landings move
  from `main` to `vibe`.
- The smithers pack's loop (audit → spec update → triage → work → review) is
  the reference implementation; keep its honesty rules (no fake success,
  features stay broken until proven) as flow contracts.
- Colocated `ui.tsx` beside the flow, per
  `docs/specs/Specs/File Conventions.md`. Compose shared components; the
  corrected pattern is the outer repo's `.smithers/ui/ddd-VaultTab.tsx`
  (composes `smthrs/ui` + the markdown-editor adapter), not the hand-rolled
  113 KB `ddd-shared.tsx` in the smithers repo.
