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
