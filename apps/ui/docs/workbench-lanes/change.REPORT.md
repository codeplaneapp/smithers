# Lane `change` — REPORT

Brief: `change.md`. ADR: `../decisions/0003-change-unit.md`. Status: all four
steps shipped and green; the lane's gates pass, and the only failures in the
tree are the three pre-existing TargetGraph integration tests (the
`~/artsy/force` fixture). Two concurrent-lane breaks found mid-lane were
completed mechanically, below.

## What shipped, per step

1. **Shared schemas** (`apps/shared/src/Changes.ts`, `Cards.ts`): the
   `change` card payload — repo, changeId, description, commitId, currentSeq
   / revisionCount (null until plue#450), revisions[], authorName, timestamp,
   repos[] with stat, the parent → current diff, checks, findings, reviews,
   threads, conflicts[], the stack position row, the changeset (ADR 0003's
   live DTO: id, organization, changeId, state pending|landing|landed|failed,
   failureReason, targetBookmark, members[]), facet, error — and the `diff`
   card payload (repo, changeId, from, to, the revision pin
   `{ changeId, seq, commitId }`, files with `patch` inline or `patchLines`
   by reference past 400 lines, `conflicted`). The `file` card's `readAt`
   gains an optional `seq`. `ChangesetState` carries the changeset's own
   `changeId` so a change matches its changeset by id or by member.
   Deviation: the `search-results` card kind does not exist (piper
   established `file` only), so the pin went on `file` alone.
2. **Model + seam.** `changes` collection (`app-changes`, registered in
   `SchemaVersion.ts`), keyed `${repoId}#${changeId}`; `change.loaded`
   upserts from the wire DTO (one commit, no revisions — currentSeq /
   revisionCount stay null, never invented). `state/seams/ChangeSeam.ts`
   covers every live plue route — the change, its diff, its conflicts, the
   landings list (stack position from `change_ids`), landing reviews and
   comments, commit statuses (newest per context by `created_at`, never
   last-write-wins), the org changesets — and refuses honestly where no
   route exists: rev-pinned views (plue#450), interdiffs (#451), split-ready
   (#452), agent resolve (#455), revert (#456). `change.land` lands the
   carrying landing request (queued, never "merged") or the changeset
   through its own atomic route (a 409 re-reads so `failure_reason`
   renders). Revert is gated on landed: the landing's `merged` or the
   changeset's `landed` (plue's landing states verified in
   `internal/services/landing.go`: open, closed, merged, draft, queued,
   landing, failed). A bare act resolves the repo from the changes
   collection, else the app's target repo — never a guess. Signed-out
   refuses with the sign-in step; a degraded session reads freely, and
   dispatching the resolve agent refuses with the exact "sign in again to
   enable" wording. 22 seam tests against route doubles.
3. **The `change` and `diff` cards** (`cards/ChangeCards.tsx`, registered in
   `ChatCards.tsx`, pill "done" as a settled read). The change card's header
   names `repo · changeId · shortCommit · author`, never `rev N of M`. Five
   facets: Diff (file rows, each opening `/change.diff <id> parent current
   <path>`), Findings (the plue#454 wording), Checks (one row per context),
   Review (verdicts and threads; no stale/moved tokens until plue#453 — the
   wording says so), History (the plue#450 wording; a revisions list when
   the backend carries them). A conflicted change names its files and offers
   Resolve; a landed one offers Revert; a changeset's failure renders
   verbatim with Retry land; a changeset's change offers Split ready. The
   diff card renders `from → to` pinned at the change's commit, conflicted
   files leading, binary files named, oversized hunks by reference with the
   re-read command. 17 card tests.
4. **Flows + origin chip.** `change.view|diff|land|split-ready|resolve|
   revert` (confirm per the ADR's table: "land the change", "split the ready
   members into a new change", "dispatch an agent to resolve the conflict",
   "revert the landed change") plus hidden `change.facet`; slash payloads
   with honest refusals; the `change` namespace in `registry.ts`;
   registry/parity pins updated. The composer's origin chip carries the
   probed checkout's pin `~/smithers · qupxosqw · a03f5f` (`changeId#seq`
   only when the changes collection knows a sequence — never from a commit
   comparison alone), beside piper's `N ahead of main`; `rev N exists ·
   view` renders only when BOTH seqs are known and runs `/change.view`.
   2 new chip tests.

## Exit gate

- Seam tests: 22, doubles for every route, including the degraded session
  (view reads, resolve refuses with the enable wording) and the absent-
  answer-is-absent-field rule.
- Card tests: 17, per facet and per degraded state (history, findings,
  stale/moved, conflicted, landed, failed changeset, oversized hunk).
- T1 (`e2e/playwright/change.spec.ts`, 4 tests): a fixture landing request's
  change end to end (DTO, stat, stack position, checks, the plue#450 History
  wording, never `rev 1 of`), the pinned diff card, the rev-pinned refusal,
  the degraded read-free/refuse-dispatch split. Org changeset reads route
  through the double; the canary org was not needed.
- Gates: `tsc --noEmit` clean; `bun test src` 1428 pass / 3 fail — exactly
  the pre-existing TargetGraph integration failures; apps/shared 130 pass;
  apps/server 402 pass; playwright 4 pass.

## Concurrent-lane completions (not this lane's scope, kept green)

A concurrent lane edited `WorkspaceSeam.ts` mid-flight (typed-name delete
gate, paginated list routes, card-from-collection rendering) leaving call
sites and tests stale. Completed mechanically, no behavior invented:
`workspace.delete` flow/slash parser/card button pass the typed name; the
list route doubles gained `?limit=100`; the open test's status expectation
follows the card's freshest row (the watch's first poll).

## Never faked

Revisions and `rev N of M` (#450), interdiffs (#451), landable prefix /
blocked_by (#452), verdict commit ids and thread anchor state (#453),
findings per revision (#454), agent resolve (#455), revert (#456),
per-change operations (#457). Each renders the ADR's wording or refuses
with it; the routes that exist are the only ones called.
