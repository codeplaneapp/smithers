# Testing-framework campaign — remaining work

_Context: crash-recovery lineage ending (currently) at run `tf-final-replay-identity-20260718`
(implement-testing-framework-e2e). Substance is nearly done: the framework implementation passed
sol's readiness gate, fable's consensus review approved with zero issues, and sol's last consensus
objection was only that the root `pnpm test` gate is red (8 workspaces, at least partly
pre-existing breakage). Full recovery log: memory file
`project_crash_recovery_testing_framework_run.md`._

## Drive the run to completion
- [ ] Resume `tf-final-replay-identity-20260718` whenever it quota-parks with a dead engine:
      `env -u ANTHROPIC_API_KEY smithers up .smithers/workflows/implement-testing-framework-e2e.tsx --run-id tf-final-replay-identity-20260718 --resume true --force true -d`
      (next fable window reset: 2026-07-19T20:50Z; an engine is currently alive holding the park —
      if it survives, the dispatch is automatic).
      _(2026-07-19 ~21:00Z: engine was dead at reset; plain resume then hit RESUME_METADATA_MISMATCH —
      a 16:39 EDT edit to the workflow file (reusePlanRunId digit-lookahead) + sibling-lane
      packages/smithers/src edits changed the entry/module-graph hashes. Recovered with
      `--accept-workflow-change true` (re-blesses metadata); run resumed running-healthy at
      sol-readiness-review. Plain resume command works again unless the file changes anew.)_
      _(2026-07-19 ~23:52Z: force-resumed again with `--accept-workflow-change true` after
      restoring the remaining workflow-file improvements. The run is at 39 done / 49 pending,
      quota-parked on fable until 2026-07-25T16:00:00.226Z.)_
- [ ] Remaining in-run path: fable-as-sol readiness re-review → (improvement rounds as needed) →
      consensus reviews → assess → `final-verify-and-summarize`. Watch via
      `smithers ui tf-final-replay-identity-20260718` or `smithers status`.
- [x] The last substantive blocker sol raised: root `pnpm test` red (8 failing workspaces —
      including the `apps/kimi-benchmarks-site` UI-inventory gate entry and the missing
      `@smithers-orchestrator/microsandbox` workspace link, both judged outside the target diff).
      If the run's improvement rounds don't clear them, fix/land these root-gate failures directly.
      _(2026-07-19: isolated the contaminated sweep failures and landed fixes for the genuine
      react-reconciler DevTools version, DB output-provenance leak, stale migration-head tests,
      CLI fork-provenance fixture, generated type docs, workflow ownership inventory, and sealed
      gate PATH. `packages/testing` passes 144/144 and `.smithers` passes 590/590; full root
      `pnpm test` has not yet been re-run.)_
      _(2026-07-20 ~01:00Z: the full root rerun reached every workspace and ended with only three
      package failures: CLI's XState spec inventory check raced the concurrent XState landing;
      `.smithers` needed its derived DDD modules regenerated; and engine's module-resolution test
      copied 443 MB of workspace-local `.smithers` runtime state into its fixture. Current focused
      CLI/DDD reruns pass, the DDD regeneration landed as `0c3526d3f7`, and the fixture exclusion
      plus regression test landed as `4ad19b20c8` with engine 1036/1036 passing. A fresh whole-root
      pass is still required before checking this item.)_
      _(2026-07-20 ~02:25Z: a clean isolated whole-root `pnpm test` rerun completed successfully
      across all 62 workspaces. `packages/components` passed 689/689, `packages/testing` passed
      145/145, and the root command exited 0.)_

## After the run finishes
- [ ] Verify the final summarize output + jj log; confirm all rounds are committed (the workflow
      commits each accepted round — verify no uncommitted `packages/testing` / `e2e/testing-framework` work).
- [ ] Commit the uncommitted workflow-file improvements in `.smithers/workflows/implement-testing-framework-e2e.tsx`:
      `<UI>` wiring + import, `reusePlanRunId` regex fix, `IMPL_LONG` 60m lane timeouts,
      `?.issues?.some` guards, luna→fable implementation lanes.
- [ ] Revert (or gate behind `codexPaused()`) the temporary sol→fable reviewer swap when the codex
      weekly window resets on 2026-07-25 — see the dated comment in the workflow file.
      _(2026-07-19: checked — window not yet reset, revert stays pending until 2026-07-25.)_
- [ ] Run `pnpm typecheck` + the `.smithers` workflow tests before landing workflow-file changes
      (check `implement-testing-framework-e2e-workflow.test.ts` still passes with the new agents).

## Smithers defects surfaced by this campaign (fix at the source)
- [ ] **Quota-park kills the engine** — every quota park in this campaign left a dead engine, so
      nothing auto-resumes at window reset (auto-dispatch works when an engine is alive). File +
      fix (daemonize the park-hold, or have `smithers supervise` cover quota-parked runs).
      _(2026-07-19: FILED as #1357; corrected after log forensics — gateway HAS swept quota parks
      since 96674f5893 and DID fire at the 20:50Z reset, but resume failed silently with
      RESUME_METADATA_MISMATCH (source drift while parked). Real work items on the issue:
      surface permanent sweep-resume failures on the run, scrub ANTHROPIC_API_KEY from
      gateway-spawned engines (verified in daemon env via ps eww), stop unknown-workflow retry
      spam. Fix not yet landed.)_
- [ ] #1348 — snapshot input recorded pre-validation (string `maxRounds`) breaks fork/restore of
      old checkpoints. Filed, needs fix.
- [ ] #1349 — control-plane DB unbounded growth (was 100GB; legacy inline snapshot rows +
      no retention/GC). Filed, needs `smithers db gc` + retention config + migration.
- [ ] DB-swap operational trap: renamed live DB stays pinned by every open handle —
      `smithers claude monitor` daemons held 100GB of deleted inode for a day. A swap/compact
      command should kill/restart all workspace smithers processes, not just engines.
- [ ] Gateway mounts workflow UIs only at boot (`smithers ui` opened the wrong/no UI until the
      gateway was restarted) — known defect, still open.

## Housekeeping
- [x] `smithers.db.bak` already deleted; disk stable (204GB free, db compacted to 6.3GB — verified 2026-07-19). Nothing further.
- [ ] Memory file is current through 2026-07-19 morning; append the final run outcome when it lands.

# Shared UI library campaign — remaining work

_Context: mission = every reusable UI component in this repo and ../multi importable from the
shared packages (`smithers-orchestrator/ui` + `/gateway-ui`). Extraction run `run-1784418919774`
built 10 components in worktrees; recovery merge train `run-1784453941803` (land-shared-ui) FINISHED
2026-07-19 with ALL 10 landed on local main: CollapsiblePanel, DiffHunks + diff domain, FileTree,
Markdown, MarkdownEditor (Milkdown), NodeOutputCard (gateway-ui), PierreDiffView (@pierre/diffs),
StageStrip, Terminal (xterm), WorkflowGraph (xyflow/dagre). A second concurrent-clobber orphaned 6 of
them; they were recovered by linear-chain cherry-pick (8fbc061cf0..1eef7ff71c) + CAS update-ref onto
main, CI re-verified (ui 142 pass, gateway-ui 86 pass, check-ui-architecture/docs green, llms bundles
regenerated in 7a915c63a9)._

## Finish the merge train (mostly automatic)
- [x] Last lane `merge-run-1784418919774-0-workflow-graph` (xyflow/dagre WorkflowGraph →
      gateway-ui) is quota-parked until 2026-07-19T20:50Z; auto-resumes. If the engine died with
      the park, resume: `smithers up .smithers/workflows/land-shared-ui.tsx --run-id run-1784453941803 --resume true -d`
- [x] After it lands the run auto-runs: land-ci gate (typecheck + both UI package suites +
      check-ui-architecture/docs/llms) → opus fix pass if red → landing report. Watch:
      `smithers ui run-1784453941803` (gateway on :58406).
- [x] End-of-train verification (concurrent-clobber hazard, see memory
      `gotcha_concurrent_main_move_orphans_landings.md`): re-run
      `git merge-base --is-ancestor <sha> main` for ALL 10 landings; re-cherry-pick + CAS
      `update-ref` any orphans. Already recovered one 3-commit orphaning this way.
- [x] Verify the two dependency-adding lanes (terminal → @xterm/xterm, workflow-graph → xyflow/dagre,
      pierre-diff → @pierre/diffs, markdown-editor → milkdown) refreshed BOTH pnpm-lock.yaml and
      bun.lock; docs bundles were deliberately deferred — ensure `pnpm docs:llms` ran (fix pass
      should catch via check-llms, but verify).
- [ ] Push: nothing has been pushed — local main is ~15 commits ahead of origin. Push when ready.

## Commit the campaign's own tooling (uncommitted in working copy)
- [x] `.smithers/workflows/shared-ui-library.tsx` + `.smithers/ui/shared-ui-library.tsx` +
      `.smithers/tests/shared-ui-library.test.tsx` + `.smithers/package.json` test registration.
- [x] `.smithers/workflows/land-shared-ui.tsx` + `.smithers/ui/land-shared-ui.tsx` +
      `.smithers/tests/land-shared-ui.test.tsx` (all tests green, check-smithers-test-script passes).

## Before relaunching batch 2 — fix the workflow defects batch 1 exposed
- [x] shared-ui-library.tsx: batch loop advanced to merge/audit while lanes were still
      pending/parked (audits saw ticketResults=[] though 5 lanes had finished), and discovery in
      batches 2–4 returned zero tickets instead of re-ticketing unfinished lanes. Gate the merge
      queue + audit on all lanes settled, or make discovery re-ticket unlanded work.
- [x] Merge prompts (both workflows): require CAS main moves (`git update-ref refs/heads/main
      <new> <expected-old>`) + prior-landing ancestry re-verification before advancing main.

## Batch 2+ mission gaps (from the four batch audits — seed the next shared-ui-library run)
- [ ] Consumer migration in this repo: 17 of 68 `.smithers/ui/*.tsx` import no shared subpath
      (ddd-* family, create-workflow/cw-*, delegation-chain, issue-blitz, issue-train,
      microsandbox-finish, share-pack); ~26 files hand-roll `width:%` meter bars; ~33 carry
      duplicated per-file <style> blocks; break-smithers defines a local Badge; issue-blitz
      hand-rolls Chip + status color map; ship-pipeline + research-plan-implement define
      independent Panel cards.
- [ ] Consumer migration in ../multi: 0 of ~333 tsx files import the shared packages despite
      `@smithers-orchestrator/ui` being a declared dependency; two independent StatusPill
      implementations; ~37 raw `.btn` buttons; ~20 hand-rolled tab strips + empty states.
- [ ] Missing primitives the audits named: CommandPalette (multi src/palette + CommandMenu),
      shared icon set (multi src/icons), avatar/checkbox/dropdown-menu/popover/scroll-area
      (reserved in check-ui-architecture DUPLICATE_WRAPPER_NAMES but unshipped), gateway-ui
      ProgressBar/Meter + generic monospace LogView/CodeBlock, chat surface unification
      (multi src/chat vs packages/ui chat/*).
- [ ] Facade drift: gateway-ui `NodeRow` exists but is not exported from its index;
      `styleguide-css` subpath not reachable through the smithers-orchestrator facade.
- [ ] Burn down the 104 allowlisted legacy violations (was 94 at audit time, 104 after the six-lane recovery unioned its baseline entries) in `scripts/ui-architecture-baseline.json`
      (18 legacyPackageUsage, 12 heavyWidgetDependencies, 8 duplicate wrappers/icons, plus
      compatibility-facade + gateway-react-location entries).
