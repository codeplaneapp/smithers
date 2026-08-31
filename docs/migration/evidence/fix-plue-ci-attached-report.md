# Fix lane: plue-ci-attached

Round 1. Branch `smithers-rc0-cutover`, worktree
`/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/wt/plue-cutover`.
Commit `976a170a6`, "launch the CI tiers attached so the pipeline job carries
the tier's verdict". Lockfiles unchanged; no manifest changed.

Setup: `git status --short | wc -l` → 0; `corepack pnpm install --frozen-lockfile`
→ `Done in 683ms using pnpm v10.6.5`; `bun install --frozen-lockfile` in
`cmd/runner/workflow` → `Checked 36 installs across 62 packages (no changes)`.

## Item P1: the pipelines launch detached

### Confirmed at the source

`.github/workflows/pipeline-fast.yml:37` before the fix:

```
      - run: smithers up ci-fast -d --data "{\"sha\":\"$GITHUB_SHA\"}"
```

`.github/workflows/pipeline-thorough.yml:39` before the fix:

```
      - run: smithers up ci-thorough -d --data "{\"sha\":\"$GITHUB_SHA\"}"
```

Neither file used `--json` and neither captured a runId, so there was nothing
to keep on that count. The upload step already followed the run step and already
carried `if: always()`.

### Reproduction

The gate's own run is the reproduction, `plue-cutover-logs/18-up-detached.stdout`:

```
{"detached":true,"logFile":"/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/plue-clean-cutover/.flows/logs/run-3.log","runId":"run-3"}
```

Exit 0 after 5 s; the run failed afterwards in the child. A GitHub job shaped
that way finishes before the tier runs, so it is green whatever the tier decides
and the `if: always()` receipt upload races the child still writing the receipt.

### Behavior test

`scripts/ci-flows-contract.test.ts`, two new `test.each` cases over both files:

- `.github/workflows/pipeline-fast.yml launches the engine attached so the job's exit code is the tier's`
- `.github/workflows/pipeline-thorough.yml launches the engine attached so the job's exit code is the tier's`
- `.github/workflows/pipeline-fast.yml uploads the receipts after the attached run, not beside it`
- `.github/workflows/pipeline-thorough.yml uploads the receipts after the attached run, not beside it`

The first pair asserts the launch line carries no `-d` and no `--detach`. The
second pair asserts the `actions/upload-artifact` step still follows the launch
and still carries `if: always()` (a pin, green before and after).

### RED, against the pre-fix workflow files

`bun test scripts/ci-flows-contract.test.ts` → `13 pass, 2 fail`, load 8.95:

```
83 |     expect(launch).not.toMatch(/\s-d(\s|$)/);
                            ^
error: expect(received).not.toMatch(expected)

Expected substring or pattern: not /\s-d(\s|$)/
Received: "      - run: smithers up ci-fast -d --data \"{\\\"sha\\\":\\\"$GITHUB_SHA\\\"}\""

      at <anonymous> (/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/wt/plue-cutover/scripts/ci-flows-contract.test.ts:83:24)
(fail) Plue's CI flows are the shape the rc.0 CLI runs > .github/workflows/pipeline-fast.yml launches the engine attached so the job's exit code is the tier's [0.73ms]
```

and the same assertion for the thorough tier:

```
Expected substring or pattern: not /\s-d(\s|$)/
Received: "      - run: smithers up ci-thorough -d --data \"{\\\"sha\\\":\\\"$GITHUB_SHA\\\"}\""
(fail) Plue's CI flows are the shape the rc.0 CLI runs > .github/workflows/pipeline-thorough.yml launches the engine attached so the job's exit code is the tier's [0.37ms]
```

### Fix

- `.github/workflows/pipeline-fast.yml:43` — `- run: smithers up ci-fast --data "{\"sha\":\"$GITHUB_SHA\"}"`, `-d` dropped.
- `.github/workflows/pipeline-thorough.yml:45` — `- run: smithers up ci-thorough --data "{\"sha\":\"$GITHUB_SHA\"}"`, `-d` dropped.
- Both files gained a five-line comment above the step recording why the launch
  is attached.
- `scripts/ci-flows-contract.test.ts:66-113` — the four new cases.
- `docs/migration/smithers-rc0-pack-dispositions.md:81-82` — the two Tier 1 rows
  said "Plue CI runs it as `smithers up ci-fast`"; they now say Plue CI runs it
  attached and name the `-d` failure mode.

The job's timeouts already fit an attached run: fast 35 minutes, thorough 90.

### GREEN

`bun test scripts/ci-flows-contract.test.ts` → `15 pass, 0 fail, 48 expect() calls`,
load 7.81.

Both files still parse as GitHub workflow YAML, and the upload step is the step
immediately after the launch:

```
pipeline-fast.yml steps 10 | launch: smithers up ci-fast --data "{\"sha\":\"$GITHUB_SHA\"}" | next: actions/upload-artifact@v4
pipeline-thorough.yml steps 11 | launch: smithers up ci-thorough --data "{\"sha\":\"$GITHUB_SHA\"}" | next: actions/upload-artifact@v4
```

### Dependency on the Smithers cli-exit-code lane

Attached is necessary but not yet sufficient. Today attached `smithers up` exits
0 for a `control.run.failed` settlement (gate finding S1,
`packages/cli/src/Command.ts:372-392`), so an attached red tier still reports a
green step. The job's exit code becomes the tier's terminal status only once the
Smithers `cli-exit-code` lane lands. This lane's change is the half Plue owns;
it needs no rework when that fix ships.

## Report update

`migration/finish/plue-cutover-report.md` acceptance item 10 now records the
attached launch, the detached failure mode it replaces, the pin, and the
`cli-exit-code` dependency.

## Gates

| Gate | Load at start | Result |
| --- | --- | --- |
| `bun test scripts/ci-flows-contract.test.ts` (RED, pre-fix) | 8.95 | `13 pass, 2 fail` |
| `bun test scripts/ci-flows-contract.test.ts` (GREEN) | 7.81 | `15 pass, 0 fail, 48 expect() calls` |
| `bun test scripts/` | 6.15 | `298 pass, 0 fail, 1238 expect() calls, Ran 298 tests across 40 files` (294 before; the 4 new cases are the difference) |
| `zig build check-naming` | 6.15 | exit 0, silent |
| YAML parse of both pipelines | 6.15 | both load; launch step immediately precedes the upload step |

Dependents: `git grep` for `pipeline-fast`/`pipeline-thorough` outside the
dispositions doc hits only `scripts/ci-flows-contract.test.ts`. No Go, Zig, or
runner code reads these workflow files.
