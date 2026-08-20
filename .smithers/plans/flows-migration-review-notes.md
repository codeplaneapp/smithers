# flows-migration review criteria

Orchestrator notes for `run-1787103700592`. These are the checks applied at each
lane approval gate, on top of the mechanical gate the workflow already runs
(non-empty diff plus the lane's declared checks).

## Baselines measured before the run

| Fact | Value at launch |
| --- | --- |
| `node scripts/check-single-effect-version.mjs` (smithers) | passes, reports `4.0.0-beta.105` |
| flows effect pin | `4.0.0-rc.108` exactly |
| smithers trunk | `main` at `584f479a8041` |
| flows trunk | `main` at `ceb784b66fc5` |
| Colliding published names | engine, gateway, memory, sandbox, scorers, testing, time-travel |
| Workspace add + `pnpm install --frozen-lockfile` cost | smithers 13s / 234 MB, flows 24s / 122 MB (hardlinked) |

## Rules applied to every lane

1. The diff must be non-empty and confined to the lane's declared scopes.
2. A green check is not enough when the check passes both before and after. Read
   what the check asserts, then verify the value changed in the intended
   direction.
3. No weakened test, deleted assertion, or mocked backend to reach green.
4. Manifest or lockfile changes refresh both `pnpm-lock.yaml` and `bun.lock` in
   the smithers repo. The flows repo has only `pnpm-lock.yaml`.
5. Public export, type, or doc changes carry their regenerated bundles
   (`check-docs`, `check-llms`, `check-dts`).
6. The lane worked in its own jj workspace. Neither shared checkout changed.

## Stage 0

- **effect-rc108-bump** (smithers). `check-single-effect-version.mjs` must report
  `4.0.0-rc.108`, not merely exit 0: it passed at `beta.105` before the lane, so
  exit status alone proves nothing. The bridge in `packages/engine/src/effect/*`
  is the real risk surface (activity, compute-task, deferred-state, entity
  worker, single runner, builder, RPC schema); its internals tests must pass
  rather than be skipped. Both lockfiles refreshed.
- **alpha-release-train** (flows). Must rename nothing. The naming decision is
  settled: flows keeps the bare `@smthrs/*` names (commit `84fd9eb5bd29`). The
  lane ships the `alpha` dist-tag guard, so verify a test fails when the publish
  step would move `latest` on any of the seven colliding names. H1 to H4 stay
  maintainer tasks and must not be faked.
- **flows-runcontrol** (flows). Attribution means actor and reason on the
  journaled control event, not a comment. Look for the pause and hijack fault
  cases and the restart-lineage case.
- **flows-checkpoint-capability** (flows). Must be layer-gated with a browser
  no-op, invoked at step boundaries by the owning runtime, not by an engine-wide
  hook. The browser bundle check must still pass.
- **flows-pg-dialect** (flows). The honest proof is the journal and engine-store
  suites running against PGlite as a second backend. Out-of-ladder DDL from
  `EngineStateSchema.ts` must be ported, `flows_run_parents_gc` included.
- **parity-harness** (smithers). Oracles must be recorded from real runs, not
  hand-written to match. This suite gates every later lane, so a shallow harness
  here is the most expensive defect in the program.

## Stage gates

A stage sign-off needs the integration bookmark to exist in each repo that has
lanes, the stage checks green on the integrated result, and no lane left in
`blocked` without its reason recorded in the stage report.

## Defects found in the workflow itself (fix after the run)

Editing `.smithers/workflows/flows-migration.tsx` or `.smithers/lib/flowsMigration.ts`
while the run is live would change the resume hash of a parked run, so these
wait until the program finishes or sits between stages.

1. Persisted rows come back snake_case (`diff_stat`, `failures_json`,
   `gate_key`). `summarizeGate` reads `failuresJson ?? failures` and the lane
   report reads `diffStat`, so both silently render empty. Read both spellings.
2. `plan-approval` has no `onDeny`, so it defaults to `fail`. A denial kills the
   run instead of re-planning. Give it `onDeny="continue"` and re-render the
   planner when the decision is denied.
3. An unreachable lane (its dependency never went green) counts as settled in
   `laneSettled`, so a stage can integrate while a dependent lane never ran. The
   stage report shows it as `pending`, which is the only signal. Make integrate
   require every lane either settled or explicitly unreachable-and-reported.
4. Lane approvals are blocking (`<Approval>` without `async`), and the engine
   will not start a blocking approval while other lanes still have live work,
   because doing so parks the whole run. Approvals therefore batch until the
   build wave drains. Observed on `alpha-release-train:approval`: rendered in
   the graph with `needsApproval=true` and `until=false`, but never scheduled
   while three other lanes were running. `stacked-ship` has the same shape, so
   this is engine semantics, not a defect here. Adding `async` to the lane
   approval would let each lane park independently and is the better shape for
   a wide fan-out; make that change with the other post-run fixes.

## Orchestrator interventions (run-1787103700592)

- **flows-runcontrol, round 3.** Rounds 1 and 2 both failed the same way: the
  control hold was enforced by a read that races the write clearing it (round 1
  never read the reason at all; round 2 read it before `claimAndActivate`, and
  `wake` then cleared the row unconditionally). Steered to make the invariant
  structural instead of narrowing the window: `wake` must refuse to clear a
  waiting row whose reason is a control reason, and the hold must be enforced
  inside the claim's CAS, not in a read before it. A guard that runs before the
  claim can be raced; a `WHERE` clause on the claim cannot.
- **flows-pg-dialect, round 3.** The lane was being held to "engine-store passes
  on both backends" while the blocker (five `RAISE(ABORT)` triggers in
  `@smthrs/plan` `0001_initial`) sat outside its declared scopes, so the bar was
  unreachable without a scope violation. Authorized widening to
  `packages/plan/` for exactly that port, with the constraint that abort
  semantics stay identical across dialects and each ported trigger keeps a test
  proving it still aborts.

## The three base defects (all fixed in resolveLaneBase)

A lane's workspace base is the whole ballgame. Three separate ways it was wrong:

1. **Stage base.** Lanes branched from trunk, so a stage-N lane could not see
   stage N-1's work at all. `db-adapter-compat` correctly reported `blocked`
   rather than fabricating. Fixed: probe backwards through `ALL_STAGES` for
   `flows-migration/<key>/stage-<id>` in the lane's own repo.
2. **Dependency code.** `dependsOn` gated *when* a lane ran but not *what it
   could see*. `dual-engine-routing` depends on `graph-plan-compiler`, but its
   base lacked `packages/flows-compile`, so `runWorkflowOnFlows` could only
   throw `FLOWS_ENGINE_PLAN_COMPILER_MISSING` and parity stayed green on one
   engine instead of two. Fixed: base a lane on its dependency's bookmark, or
   on a merge of them created with `jj new --no-edit` and located by parentage
   (`children(depA) & children(depB)`), which is exact.
3. **External prerequisite.** Even a correct base could not make flows
   importable, because the alpha is unpublished. Fixed outside the workflow by
   vendoring (see spec 0.2a).

Lesson for any future fan-out workflow: an isolated lane sees exactly its base
commit. Ordering constraints and code visibility are different problems, and a
DAG of lanes needs both.

## Environmental blocker: the machine is chronically full

The volume is 926G with ~890G used and refills faster than it can be reclaimed
(41Gi free -> 3.6Gi in 90 minutes on 2026-08-19, twice). A disk-full event at
~07:55Z already killed one run, all four monitors, and the vendoring oneshot
(bun panic after "cannot rollback - no transaction is active").

Reclaimed safely and already spent: bun install cache (3G), pnpm metadata cache
(1.1G), finished lane workspaces, a partial `pnpm store prune` (~6G, crashes
under pressure but frees before it does). Those levers are now exhausted.

Not touched deliberately: `.smithers/worktrees` (24G, other campaigns, holds
unlanded recoverable work), `~/Library/pnpm/store` (19G, every node_modules
hardlinks into it), `smithers.db` (10G, held by the live engine so it cannot be
vacuumed).

A lane workspace costs only ~230MB of real disk (pnpm hardlinks from the store),
so this program is not the cause. Owner action is required before stages 2 and
3, which add eleven more lanes.

## Approving a gate cancels in-flight work on other lanes

`smithers approve` / `deny` auto-resume the run, which restarts the driver and
CANCELS in-flight agent attempts on unrelated lanes. Observed on
`checkpoints-timetravel:implement`: attempts 1 and 2 were cancelled (168s and
500s of work discarded) by two unrelated gate resolutions, leaving attempt 3
with the retry budget exhausted.

With `retries=2`, three gate resolutions during one long lane will fail it.
Batch approvals, and prefer resolving gates when no long implement is running.
