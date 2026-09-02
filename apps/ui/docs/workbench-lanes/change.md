# Lane `change` — the change card, diff, and revision pins

Brief: `../decisions/0003-change-unit.md` §1, §3, §5. Laws as every lane.
Depends on: lane `piper` (cloud proxy, repositories collection, header pin).

Scope, in order:
1. Shared schemas (`apps/shared/src/Cards.ts`, `apps/shared/src/Changes.ts`):
   `change` card payload (id, currentSeq, revisions[], description, repos[]
   with stat, checks summary, findings summary, review summary, conflicts[],
   stack position, landing state), `diff` card payload (from, to, files,
   hunks by reference past 400 lines), the revision pin `{ changeId, seq,
   commitId }` on `file` and `search-results`.
2. `ChangeSeam` over `/api/cloud/…/changes/{id}`, `…/diff`, landing
   requests; a `changes` collection; the `change` card with the Diff,
   Findings, Checks, Review, History facets exactly as §1, stale tokens as
   "How stale reads"; the `diff` card with the two revision pickers.
3. Flows `change.view|diff|land|split-ready|resolve|revert` with confirm per
   the table; slash payloads; registry/parity tests.
4. Origin chip pin `qupxosqw#5`; `rev N exists · view` line on pinned cards.
Exit: seam tests with doubles for every route (including a 403 degraded
session); card tests per facet and per stale/moved state; T1 spec viewing a
fixture landing request end to end. Never fake a route the backend lacks:
render the facet empty with the ADR's wording.
