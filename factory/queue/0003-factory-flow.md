---
status: queued
anchor: head
priority: p1
---

# The factory flow

Implement the queue processor from the "Software Factory" spec as flows and
Actions (the "Unified Flow Authoring" spec), replacing the smithers DDD pack as
this repo's operator.

- A trigger door over `factory/queue/`: item files decode through one
  schema; the
  item digest keys the run.
- Phases as steps with kernel-enforced envelopes: docs (writes `docs/**` and
  package READMEs only) → gate (vault check + docs parity) → implement (lane
  based at the item's anchor, per the "Worktree Lanes" spec) → verify
  (affected smithers build targets) → land (merge queue onto `vibe`) →
  retell (fold into `main`, tree-equality gate).
- The retell step is the cutover point described in the "Clean History" spec:
  when it ships, landings move from `main` to `vibe`.
- The smithers pack's loop (audit → spec update → triage → work → review) is
  the reference implementation; keep its honesty rules (no fake success,
  features stay broken until proven) as flow contracts.
- Colocated `ui.tsx` beside the flow, per the "File Conventions" spec. Compose
  shared components; the corrected pattern is the 0.x workflow pack's
  `ddd-VaultTab.tsx`
  (composes `smthrs/ui` + the markdown-editor adapter), not the hand-rolled
  113 KB `ddd-shared.tsx` beside it. Neither file is in this repository.
