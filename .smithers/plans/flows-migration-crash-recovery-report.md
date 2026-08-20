# flows-migration run-1787129751589 — crash recovery and supervision report

Written by the crash-recovery session (`fb9fb53b`) on 2026-08-19/20. Covers the
machine crash at ~08:49 PDT, the recovery, and every lane decision made after it.

## What crashed

The machine rebooted at ~08:49 PDT. One Smithers run was orphaned:
`run-1787129751589` (flows-migration), started by claude session
`9d46a3aa-1182-4ada-8fb8-a5cdd17c165b`. Engine heartbeat went stale at
15:49:24Z; the DB still read `running` while the process was gone.

Three other claude sessions in this repo died in the same reboot but had already
delivered their work (flows telemetry landed at HEAD; flows-ui report in
`~/flows/ui`; the resolver-gaps thread committed as `95f335293f` /
`dbd18fc110` / `8be67af38d`..`ab33271c53`). No recovery was needed for them.

The crash is still visible in the run: `checkpoints-timetravel:review`
iteration 1 records `Attempts: 2 (1 cancelled, 1 succeeded)` where attempt 1 ran
4h55m and was cancelled mid-flight.

## Recovery

`bun apps/cli/src/index.js supervise -r run-1787129751589` adopted the run on
its first poll and resumed it (`attempt 1 with pid 14129`). Progress after
resume: 32 nodes done to 115+, zero failed nodes.

## Lane decisions

All approvals were decided by the recovery session against ground-truth
evidence, not gate text alone.

| Lane | Decision | Basis |
| --- | --- | --- |
| `waiting-runcontrol-quota` | approved | engine suite 1372/0; three prior rejections verified fixed |
| `db-adapter-compat` | denied, then approved | denied for a divergent published bookmark; approved once `jj bookmark list --all` showed local/@git/@origin all at `31c9ff08` and stale `55bb5858` abandoned (`hidden=yes`) |
| `checkpoints-timetravel` | denied x3, closed blocked-on-upstream | see below |
| `model-seam` | denied, then approved | seven defects enumerated, then all seven verified fixed in the worktree |
| `dual-engine-routing` | never reviewed | see "Known gaps" |
| stage-1 signoff | approved | integrate ok=true, typecheck + parity 33/0 |
| `port-api-agents-pool` | approved | review approve, gate green, diff audited: 11 `expect()` added, 0 removed |
| `port-cli-agents` | denied, then approved | removed a system-message guard and inverted its test; rework restored both |
| `cell-loop-agent` | denied, then approved | only `run()` was migrated; rework routed `generate()` through the cell loop |
| `harness-contract` | no decision — rounds exhausted | broken adapter and broken bidirectional composition |
| `usage-scorers` | no decision — rounds exhausted | global pending-usage record corrupts concurrent totals |
| stage-2 signoff | **denied** | stage goal unmet; see "Stage 2 outcome" |

## Stage 2 outcome — signed off NO

Stage 2 ended incomplete. Four of six lanes landed and are good; the stage was
not signed off.

**Landed and approved:** `model-seam`, `port-cli-agents`, `port-api-agents-pool`,
`cell-loop-agent`. Bookmark `flows-migration/7129751589/stage-2` is
conflict-free, `packages/agents` passes 1068 / 65 skipped, `pnpm typecheck`
clean. Nothing pushed.

**Why signoff was denied:**

1. `stage-2:integrate` returned `ok: false`. The stage goal is that the agent
   primitive replaces the Vercel AI SDK, but the integrated bookmark still
   carries `"ai": "^7.0.10"` in `packages/smithers/package.json:234` and
   `"@ai-sdk/openai": "^1.0.0"` plus `"ai": "^4.0.0"` in
   `examples/dstack/package.json`. Verified by hand at the bookmark. Integrate
   correctly declined to patch it, since it is lane-owned.
2. Specs 2.2 and 2.5 did not land. `harness-contract` and `usage-scorers` each
   exhausted three review rounds without ever reaching an approval node, so
   they were excluded from integration.
3. Both excluded lanes are genuinely defective and must not be force-merged:
   - `harness-contract`: `harnessToAgentLike` calls a nonexistent
     `ModelRequest.Message.text`, so any resolved event throws at runtime;
     `agentLikeToHarness.run` discards `host`, so composing the adapters cannot
     round-trip. Third review never completed.
   - `usage-scorers`: `packages/usage/src/modelUsage.js` keeps one global
     pending usage record, so interleaved `ModelEvent` streams overwrite each
     other and `smithers usage --run` totals and quota routing are wrong.

**To finish stage 2:** remove `ai` from `packages/smithers/package.json` and
`ai` + `@ai-sdk/openai` from `examples/dstack/package.json`, refreshing both
`pnpm-lock.yaml` and `bun.lock`; then re-run `harness-contract` and
`usage-scorers` as fresh lanes against the defects above, with `reviewRounds`
raised or their scope split — each burned three rounds without converging.

## checkpoints-timetravel: blocked on an upstream prerequisite

The lane cannot be completed against the current substrate. `grep -ril checkpoint`
across the lane workspace's `node_modules/@flows` (all 12 packages) and
`vendor/flows` returns **zero matches**: stage-0 flows exposes no Checkpoint host
capability or trigger seam to consume. Two independent rework rounds reached the
same conclusion.

Partial wiring is preserved on `flows-migration/7129751589/checkpoints-timetravel`
(commit `191fb5ee`) with time-travel tests and typecheck green.

**Unblock path:** add a Checkpoint host capability + trigger seam to flows
upstream (`~/flows`), re-vendor, then re-run this lane.

## Known gaps and defects found

1. **`dual-engine-routing` was signed off without completing.** Its `:review`
   and `:gate` nodes are still pending and its bookmark shows conflicted, yet
   stage-1 signoff proceeded. `stage-1:integrate` recorded only
   `db-adapter-compat`, `graph-plan-compiler`, and `waiting-runcontrol-quota`.
   Spec 1.3 did not land in stage 1.

2. **`pnpm check:deps` fails on `packages/flows-compile`** — undeclared
   `@flows/plan`, `@flows/core`, `@flows/harness` imports. That package belongs
   to the stage-1 `graph-plan-compiler` lane, which was **already approved and
   integrated**. The `model-seam` lane touches zero `flows-compile` files and
   inherited the breakage. Fix belongs to `graph-plan-compiler`.

3. **Gate checks have a coverage blind spot.** Lane gates run the package test
   suites plus `typecheck`; they never run `check:deps` or `lint`. Two of the
   seven `model-seam` defects lived in that blind spot, so a green gate would not
   have proven them fixed. `CHECK_ALLOWLIST` permits `pnpm`, so this is a
   planning-prompt gap, not a code restriction — the planner should be told to
   include `pnpm check:deps` and `pnpm lint` in stage checks.

4. **Only approved lanes are integrated** (`flows-migration.tsx:1135`:
   `stage.lanes.filter((lane) => decisionOfLane(lane.slug) === "approved")`).
   A lane whose code is green but whose recorded decision is a denial is
   silently excluded. This is how `dual-engine-routing` was lost.

5. **A lane that exhausts its review rounds never gets an approval node at
   all.** `reviewSettled()` is true when
   `reviewRounds(slug) >= input.reviewRounds`, so the lane counts as settled
   with no decision ever requested, and integrate then skips it. That is how
   `harness-contract` and `usage-scorers` left stage 2. The stage report does
   mark such lanes `reviewExhausted`, so this is visible — but the run
   advances to integrate without a human ever being asked about them.

6. **A green gate is weak evidence.** Three separate stage-2 lanes had
   `gate ok: true` alongside a rejecting review. Gates run tests and
   typecheck; they cannot see a weakened assertion (`port-cli-agents`
   rewrote the test that proved a security guard), an undeclared dependency
   (`check:deps` is not a gate check), or a migration that stopped short of
   the public entrypoint (`cell-loop-agent` migrated `run()` but not
   `generate()`). Never approve a lane on a green gate alone.

## The load-flake trap

`model-seam`'s rework gate reported `ok: false` with agents 1054 pass/2 fail and
engine 1363 pass/6 fail. **Every one of those failures was load-induced flake**,
produced while the run's own agents held the machine at load average 50. Each
passes in isolation:

- `capability-registry > agents without registries still hash to a stable fallback` — 6 pass, 0 fail
- `closeSingleRunnerRuntime > rejects during retry backoff` — 4 pass, 1 skip, 0 fail
- `single runner lifecycle > a run lease keeps the runtime alive across driver retry backoff` — 1 pass, 1 skip, 0 fail
- `task heartbeats > a real child that exits cannot keep a wedged agent alive` — overshot a 15000ms limit by 6ms

Re-running the full suites while the run was parked (load fell to 17) gave
`packages/agents` **1056 pass / 0 fail**, `packages/openapi` 231/0, `pnpm lint`
exit 0, `pnpm typecheck` clean.

**Lesson:** on this box, a red gate during heavy lane concurrency is not
evidence of a defect. Isolate the named failures before acting on it. Trusting
the red gate would have excluded verified-good work from the migration.

## Operational notes

- The store `/Users/williamcory/smithers/smithers.db` is **11 GB** and produces
  ~58s SQLite write stalls (retryable, self-recovering). Compaction needs the
  engine stopped; do it between runs, never on a live store.
- A headless `claude -p` resume killed itself when its duplicate-process check
  grepped `ps` for a command string its own launch prompt contained. Pass
  prompts via stdin. See the `gotcha-headless-resume-argv-self-kill` memory.
- `claude -p` cannot hold a watch: the process exits at end of turn and any
  Monitor it armed dies with it. Durable work belongs in the engine; the
  supervising session should be re-invoked per decision point.

## Related smithers fix made during this recovery

`resolveLatestIteration` picked the numerically highest loop iteration even when
it had produced nothing, so a loop node hid a finished round's data the moment
the next round was queued (`smithers output` printed `null`; `smithers node`
reported "pending, Attempts: 0"). It existed in three places: `output.js:63`,
a byte-identical copy in `diff.js:163`, and `node-detail.js:394`. Fixed via a
shared `apps/cli/src/util/resolveLatestIteration.js` that prefers the newest
settled iteration. Tests: `apps/cli/tests/resolve-latest-iteration.test.js`
(8 pass). Uncommitted.
