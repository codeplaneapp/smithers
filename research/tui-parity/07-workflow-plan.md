# 07: the workflow plan (.smithers/workflows/tui-parity.tsx)

The program executes as the `tui-parity` Smithers workflow: 8 phases, strictly sequential, each phase one isolated worktree lane with a real check oracle, an agent review, a local merge to main, and a durable human gate before the next phase. Live UI: `.smithers/ui/tui-parity.tsx` (phase cards + gates + run tree + events), opened with `smithers ui <runId>`.

## Phase DAG

```
P1 boilerplate --gate--> P2 runs --gate--> P3 approvals --gate--> P4 chat
  --gate--> P5 thin-modes --gate--> P6 palette --gate--> P7 hijack
  --gate--> P8 custom-tuis --> result
```

Per phase (node ids in parentheses; lane branch `tui-parity/<phase>`, worktree `.smithers/workflows/.worktrees/tui-parity/<phase>`, base `main`):

```
Worktree lane:
  Loop (<phase>-loop, max 4, until implemented+checks green+review approved)
    <phase>-implement   agent (implement pool)   worktree cwd
    <phase>-check       compute oracle           spawnSync with cwd = the LANE
                        worktree path (a bare compute task inside <Worktree>
                        runs at the launch root, so cwd is pinned explicitly)
    <phase>-review      agent (review pool), mounts only when checks green;
                        reviews the BRANCH diff:
                        jj diff --from "fork_point(main | <branch>)" --to <branch>
Repo root:
  <phase>-merge         agent lands the lane onto local main (no push ever)
  <phase>-post-merge    compute oracle re-runs the same checks on main
  gate-<phase>          <Approval> human gate (skippable with review=false input)
result (tui-parity-result)  static summary row, structurally last
```

## Check oracle commands

Core set every phase runs (package-scoped for speed): ui-core typecheck+test, tui-ui typecheck+test, tui typecheck+test, `node scripts/check-ui-architecture.mjs`, `node scripts/check-dependency-boundaries.mjs`, plus `pnpm -C e2e test -- tui` (bun test path filter; zmux suites skip cleanly without the daemon binary, so the oracle stays meaningful on machines without Zig while the zmux job covers CI). Phase 8 adds `pnpm -C apps/cli test`.

Agents cannot fake the oracle: it is a compute task whose exit codes come from real spawnSync runs.

## Phase exit criteria (what review enforces beyond green checks)

1. boilerplate: both packages scaffolded with docs rows + root workspace deps + both lockfiles; arch-check extended with the ui-core/tui-ui rules and baseline updated; zmux Bun harness landed with the first e2e (smithers-mon boots against a seeded gateway under the pty) green locally.
2. runs: runsList/runProgress/statusMeta + stores/bridges moved (not copied) into ui-core; multi re-imports them; smithers-mon modes consume useRunsListVm/useRunInspectorVm with unchanged behavior.
3. approvals: the approvals exemplar extracted end to end; TUI approvals mode approves a real paused run in the zmux e2e.
4. chat: chat home with composer + slash autocomplete; embeds open modes; XState machine modules ported untouched.
5. thin-modes: six modes, each a thin view over a VM; one zmux assertion each.
6. palette: palette.ts extracted; overlay works from every mode.
7. hijack: arbitrary-argv hijack + presets + picker; agent-session preserved; zmux e2e proves suspend/resume.
8. custom-tuis: `.smithers/tui/` contract + loader command + seeding twins + preference; CLI docs gates green.

## Input contract

`startPhase`/`endPhase` (default 1/1: the boilerplate-landing run), `review` (default true: human gates on), `baseBranch` (default main), `maxIterationsPerPhase` (default 4). Later phases run by launching new runs with a higher phase window once earlier phases have landed, or one long run with `endPhase: 8`.

## Operational notes

- Launch from a frozen copy (`.smithers/workflows/.frozen/`) for multi-hour runs so formatter/edit churn cannot break resume; `--accept-workflow-change` exists for formatting-only edits.
- The run must start from a committed main containing this spec set: agents work in worktree lanes based off main and cannot see untracked files.
- Output tables are prefixed `tuiParity*` to avoid cross-workflow table-name collisions in the shared workspace DB.
- Merge tasks preserve unrelated concurrent changes (jj st first, explicit pathspecs, regenerate lockfiles on conflict instead of hand-merging).
- The result task is structurally last so the run's reported output is the program summary.
