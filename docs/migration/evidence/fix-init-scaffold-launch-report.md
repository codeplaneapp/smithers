# Phase 7 fix lane: init-scaffold-launch

Round 1. Status: done. Branch `phase7/init-scaffold-launch`, worktree
`/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/wt/init-scaffold-launch`,
base `f63809382b`. Two commits, no lockfile change, worktree clean.

- `13c077343b` 🐛 fix(cli): scaffold the model seat `smithers init`'s own promise needs
- `363346c94e` 🐛 fix(control,agent): settle a run the executor was handed and could not take

Install: `corepack pnpm install --frozen-lockfile --offline` exit 0, 2m30s, no
lockfile change. `apps/ui`'s postinstall `electrobun prepare` sat at 0% CPU
behind a live `electrobun dev` holding the global hutch lock; the prepare child
was killed and the `--soft` postinstall continued (`ensure-devkit: electrobun
prepare exited by signal (continuing)`).

Logs: `phase7/fix-init-scaffold-launch-logs/`.

## The defects, confirmed at the source and reproduced with the real binary

`packages/cli/src/Init.ts:84` (pre-fix) promises the two commands:

```
 * in, so `smithers up <name>` works in the directory `init` just created.
```

and `template` wrote no `model:` line. Reproduction, working-tree CLI, scratch
directory, maintainer's ambient environment:

```
smithers init hello                                                    exit 0
smithers up hello --json                                               exit 1
stdout {"…","ownerId":"{\"hostId\":\"local\",\"pid\":0,…}","runId":"run-1","status":"accepted",…}
stderr Run run-1 was accepted but the executor did not take it: it is accepted with nothing running.
control.db flows_runs   run-1 | running | finished_at_ms NULL | state_json.status "accepted"
engine.db  flows_runs   (no rows)
```

The same shape from any `LaunchFailed` (plue-cutover S3), with a hand-written
`model: anthropic:claude-sonnet-4-5` and `ANTHROPIC_API_KEY` unset:

```
smithers up hello --json                                               exit 1
stderr LaunchFailed: Set ANTHROPIC_API_KEY to run the anthropic:claude-sonnet-4-5 seat
control.db flows_runs   run-1 | running | finished_at_ms NULL | state_json.status "accepted"
engine.db  flows_runs   (no rows)
smithers status run-1   Verdict unlaunched                             exit 0
smithers ps --json      status "accepted"
```

Two mechanics behind it.

`AgentSession.launch` answered `"pending"` for a prompt flow whose descriptor
declares no seat, in the same branch it uses for a flow it does not know:
`pending` means "not mine, somebody else may take it", and no agent host can
ever take a seatless prompt flow.

`ControlRuntime.launch` writes the run row before the executor is consulted,
and the executor's refusal fails the mutation, whose `journal.transact`
transaction rolls back. Where the run row and the control journal share one
database the whole mutation rolls back and no run survives; in the CLI they do
not — runs are in `control.db` and `ControlLive.emit` journals into `engine.db`
— so the row outlived the rollback. Measured on the fixed binary, the split is
visible directly: `control.db flows_runs` holds `run-1`, `control.db
flows_journal_events` is empty, and the `control.run.failed` record with its
cause is in `engine.db`.

## Item D1 — the scaffold declares a seat

Fix: `packages/cli/src/Init.ts`. New `Seat` model and `defaultSeat`, exported
and named in `packages/cli/README.md`'s export table; `template(name, seat)` and
`scaffold(root, name, environment)` take the seat; `Scaffolded` gains `seat`.
The seat is chosen from the provider credentials `smithers doctor` reports, in
doctor's order:

| Credential | Seat |
| --- | --- |
| `ANTHROPIC_API_KEY` | `anthropic:claude-sonnet-4-5` |
| `OPENAI_API_KEY`, or `SMITHERS_OPENAI_AUTH=chatgpt` | `openai:gpt-5.6-sol` |
| `OPENROUTER_API_KEY` | `openrouter:anthropic/claude-sonnet-4.5` |

`CEREBRAS_API_KEY` is left out on purpose: `Doctor.ts:154` names it a provider
key and `NodeControl.seatResolver` has no route for the provider, so choosing
it would scaffold a flow whose launch answers `No route is configured for the
cerebras provider` (plue-cutover S3). Every model id was verified against the
provider's own catalog (`GET /v1/models` on api.openai.com and
openrouter.ai/api/v1/models); `anthropic:claude-sonnet-4-5` is the spelling
`docs/pages/guides/writing-a-flow.md:114` and `docs/pages/reference/sota-models.md:26`
already use.

The scaffold text, exactly as written with a credential set:

```
---
name: hello
description: A starter Smithers flow.
# The model seat this flow runs on. `smithers init` chose it from
# OPENAI_API_KEY, the first provider credential this environment sets. Change
# the line to run somewhere else; `smithers doctor` lists the keys it reads.
model: openai:gpt-5.6-sol
---
```

and with none:

```
---
name: hello
description: A starter Smithers flow.
# The model seat this flow runs on. No provider credential was set when
# `smithers init` ran, so this is the default: set ANTHROPIC_API_KEY, or change
# the line to a seat you have a key for. `smithers doctor` lists them.
model: anthropic:claude-sonnet-4-5
---
```

The markdown body below the frontmatter is unchanged. The explanation is a YAML
comment because every line of that body is an instruction the agent is handed;
`Frontmatter.parse` runs the `yaml` package, which drops comments.

Tests and red lines:

| Test | Verbatim red line | Log |
| --- | --- | --- |
| `packages/cli/test/Init.test.ts` "the seat the scaffold writes" (6 cases) | `TypeError: defaultSeat is not a function` (5 cases) and `AssertionError: expected undefined to be 'openai:gpt-5.6-sol' // Object.is equality` | `01-red-init-seat.log` |
| `packages/cli/test/Bin.test.ts` "writes a seat the host can resolve, chosen from the environment doctor reads" | `AssertionError: expected '---\nname: hello\ndescription: A star…' to contain '\nmodel: openai:gpt-5.6-sol\n'` | `04-red-bin-scaffold.log` |

GREEN: `05-green-init-seat.log` (16/16), `08-bin-after-settlement.log`.

## Item D2 — a refused launch settles the run

Fix, two files:

`packages/agent/src/AgentSession.ts` `launch` (around line 1655): the body is
loaded first, then a prompt flow with no seat is refused with `LaunchFailed`
naming the line to add. A flow the composition does not know, and a module
body, still answer `pending` — both are contracts `AgentSession.test.ts` pins
("accepts nothing it cannot execute: a flow without an agent body stays
pending", "leaves a seated flow with a module body pending").

`packages/control/src/ControlLive.ts`: new `settleUnlaunched(runId, cause)`
claims the fence, writes `failed`, and journals `control.run.failed` with the
cause; `Control.run` runs it from `Effect.tapError` on the `LaunchFailed` path.
It is OUTSIDE the mutation because a settlement written inside the failing
transaction is discarded with it. A settlement that cannot be written is logged
("A refused launch could not be settled") rather than raised: the caller is
already receiving the refusal it has to act on, and replacing it with a
persistence error would hide which key is missing. This composes with the
existing settlement machinery rather than forking it — `writeStatus` through
`ControlRuntime.claimFence`/`writeStatus`, the same pair `AgentSession.settle`
uses, and `RunStore.transitionOwned` sets `finished_at_ms` for a terminal
status.

Tests and red lines:

| Test | Verbatim red line | Log |
| --- | --- | --- |
| `packages/control/test/ControlContract.ts` "leaves no run behind that its refusal did not settle" (memory adapter) | `AssertionError: expected [ { runId: 'run-1', …(8) } ] to deeply equal []` | `02-red-control-settlement.log` |
| `packages/agent/test/AgentSession.test.ts` "refuses a prompt flow that declares no seat, instead of leaving the run accepted" | `AssertionError: expected 'the launch was accepted' to contain 'agents/seatless declares no model seat'` | `03-red-agent-seatless.log` |
| `packages/cli/test/Bin.test.ts` "refuses the launch by naming the missing key, and leaves both databases terminal" | `AssertionError: expected 'accepted' to be 'failed' // Object.is equality` | `06-red-bin-settlement.log` |
| `packages/cli/test/Bin.test.ts` "is not claimed or re-driven by a later executor boot" | `AssertionError: expected [ 'accepted', 'accepted' ] to deeply equal [ 'failed', 'failed' ]` | `06-red-bin-settlement.log` |

The two Bin red lines were captured against the tree with the D1 scaffold fix
applied and the settlement fix absent, so the assertion that bites is the
settlement one rather than the missing `model:` line. The control-contract red
line was captured by overlaying `git show HEAD:packages/control/src/ControlLive.ts`
over the fixed file and restoring it afterwards.

GREEN: `07-green-control-settlement.log` (2/2, memory and durable),
`09-green-agent-seatless.log`, `08-bin-after-settlement.log` (3/3).

### The two-process real-SQLite pin

`packages/cli/test/Bin.test.ts`, describe "the smithers init scaffold, launched
as written". Every command is a real `smithers` process over one real project
directory with the provider credentials stripped from the child environment
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
`CEREBRAS_API_KEY`, `SMITHERS_OPENAI_AUTH`, `FLOWS_OPENAI_AUTH`), so the case
proves the same thing on the maintainer's shell and on a bare runner.

- Process 1 `init hello`, process 2 `up hello --json` → exit 1, stderr `Set
  ANTHROPIC_API_KEY to run the anthropic:claude-sonnet-4-5 seat`.
- Process 3 `ps --json` → one run, `failed`. Read straight from
  `control.db flows_runs`: `status failed`, `finished_at_ms` not null.
  `engine.db` holds no run row at all — the executor refused before the engine
  was handed anything, so there is nothing for a later sweep to reclaim.
- Process 4 `status <run>` prints `failed`; process 5 `gc --older-than 0s
  --dry-run --json` lists the run, which is the terminal-only projection
  (`Retention.ts:152` selects `status IN ('completed','failed','cancelled')`).
- Separate case: a later executor boot (`up hello` again, which composes its
  own executor and sweeps as it boots) leaves the first row byte-identical,
  creates no engine row, and both runs read `failed`.

## The `--json` stdout contract and the exit-code mapping

Confirmed and recorded, both shapes:

- A launch REFUSED before a receipt exists (this lane's D1/D2 shape): stdout is
  0 bytes, the refusal is one line on stderr, exit 1. Pinned as
  `expect(launched.stdout).toBe("")`. An error document on stdout would put an
  error inside the document a pipeline parses, which is the rule `smithers
  docs` already follows.
- A launch ACCEPTED that then settles `failed` (the seat resolves, the turn
  does not): stdout is exactly one JSON document, the launch receipt, exit 1.
  That is the existing pin "exits 1 for a run that settled failed, and still
  prints the receipt", unchanged and green.

`failed = 1` comes from `Command.ts` `settlementStatus`, unchanged by this
lane, and both cases exit 1 under this fix.

## The scaffold as written, on a funded seat

`packages/cli/test/Bin.test.ts`, describe "the smithers init scaffold on a
funded seat", `describe.skipIf` on `SMITHERS_OPENAI_AUTH === "chatgpt"` and the
codex store existing. It creates a real git repository, runs `init hello`
(receipt `seat: "openai:gpt-5.6-sol"`), then `up hello --json`:

```
SMITHERS_OPENAI_AUTH=chatgpt CODEX_HOME=~/.codex vitest run test/Bin.test.ts -t "funded seat"
Tests  1 passed | 56 skipped (57)                       exit 0, 315.0 s, load 3.3
```

exit 0, and `control.db` and `engine.db` both hold the run `completed` with
`finished_at_ms` set. The case is skipped without that seat (`1 skipped` in the
package run), so it never fires in CI and never makes a live call by accident.

Recorded, because it bounds the D1 claim: the maintainer's ambient
`OPENAI_API_KEY` resolves the seat and cannot complete a run. A hand-run of the
same scaffold under `api-key` auth failed on the first turn with the provider's
own words, `flows/model/ModelError: You have no credits remaining. Add credits
to continue using the API`, and settled `failed` in both databases. That is
billing, not the scaffold: the scaffold resolves, launches, and settles
correctly under both credentials.

Also recorded: a directory holding a bare, empty `.git` directory rather than a
real repository fails the run at the engine's snapshot boundary
(`@smthrs/jj/JjError: jj snapshot: Error: There is no jj repo in "."`). That is
a test-harness artifact — no operator has an empty `.git` — and the live case
runs `git init` for that reason.

## Existing pins that asserted the defect, and what they say now

Three, each rewritten to state the guarantee rather than the bug. No test was
dropped or weakened.

1. `packages/control/test/ControlLiveList.test.ts` "surfaces an executor's
   refusal as a launch failure after the run was recorded" asserted
   `items: [{ status: "accepted" }]` under the comment "The run row survives
   the refusal". Renamed "…, and settles the run it recorded"; the row still
   survives, and it now survives settled `failed`.
2. `packages/agent/test/AgentSessionFailures.test.ts` "leaves a discovered flow
   with no declared seat pending, and drives nothing" is now "refuses a
   discovered flow with no declared seat, and drives nothing", asserting the
   refusal names the flow and the `model:` line and that no status was written.
3. `packages/cli/test/EndToEnd.test.ts` launched the scaffold detached and
   relied on it staying `accepted` forever to exercise `signal`, `steer`,
   `approve`, `cancel`, and `down`. It now writes a module flow
   (`flows/idle/flow.ts`) and launches that: an agent host answers `pending`
   for a module body and drives nothing, which is the pinned contract "only
   prompt flows run on the cell harness", and it gives a durable non-terminal
   run with no seat, no network, and no stubbed composition. The scaffolded
   prompt flow can no longer stand in for it — with a `model:` line it either
   runs a real model or is refused, and a refusal settles the run.

## Deliberately not changed

`AgentSession.launch` still answers `"pending"` for a module body and for a
flow the composition does not know, so `smithers up` on a `flow.ts` still
leaves a durable `accepted` row that only `smithers cancel` ends. Both are
pinned rc.0 contracts with their own tests, the second is honest (another host
may hold that flow's registry), and neither is the shape the verdict or
plue-cutover measured. Flagged for the maintainer rather than changed.

## Gates

Loads are the 1-minute average printed by `uptime` immediately before each
command; the guard is 40 and nothing came near it. No suite needed an isolated
rerun.

| Gate | Result | Load |
| --- | --- | --- |
| `pnpm --filter @smthrs/control run check` | exit 0 | 6.9 |
| `pnpm --filter @smthrs/agent run check` | exit 0 | 6.9 |
| `pnpm --filter @smthrs/cli run check` | exit 0 | 3.5 |
| `pnpm --filter @smthrs/control run test` | exit 0, 232 passed; 93.66% stmts / 86.76% br / 90.5% fn / 94.5% lines, thresholds 83/69/74/84 | 5.2 |
| `pnpm --filter @smthrs/agent run test` | exit 0, 429 passed; 100% stmts (1275/1275), branches (592/592), functions (433/433), lines (1148/1148) | 5.3 |
| `pnpm --filter @smthrs/cli run test` | exit 0, 635 passed / 1 skipped; 81.85% stmts / 78.66% br / 76.53% fn / 82.18% lines, thresholds 78/76/72/79 | 3.5 |
| `pnpm --filter @smthrs/{control,agent,cli} run lint` | exit 0 (eslint + dprint) | 5.1 |
| `pnpm --filter @smthrs/{control,agent,cli} run circular` | exit 0 | 5.1 |
| dependents: `gateway` 94, `migrate` 374/6 skipped, `std` 283, `triggers` 37, `testing` 123/2 skipped, `flows` 403, `create-app` 93, `engine-store` 821 (100% stmts 3566/3566) | all exit 0 | 4.3 |
| `pnpm run docs:llms` | exit 0, 4 bundles regenerated | 5.4 |
| `node scripts/check-docs.mjs` | exit 0, 16 checks | 5.4 |
| `node scripts/check-llms.mjs` | exit 0, 12 artifacts current | 5.4 |
| `node scripts/generate-docs-pages.mjs --check` | exit 0, 43 pages current | 5.4 |
| `pnpm run test:jsdoc` | exit 0 | 4.1 |
| `node scripts/check-single-effect-version.mjs` | exit 0, effect@4.0.0-rc.108 (63 sources) | 4.1 |
| `pnpm exec smithers-build lint '//:knownFiles'` | exit 0, `ok: true` | 4.1 |
| live: `vitest -t "funded seat"` with the chatgpt seat | exit 0, 1 passed, 315.0 s | 3.3 |

`packages/flows/test/vitestCoverageIsolation.test.ts` is green inside the
`flows` run (403 passed): no file was added or deleted, so `known-files.d.ts`
and the coverage allowlist are unchanged. `pnpm-lock.yaml`, `bun.lock`, and
every manifest are untouched.

## Files

- `packages/cli/src/Init.ts` — `Seat`, `defaultSeat`, the seat note, `template`
  and `scaffold` signatures, `Scaffolded.seat`.
- `packages/cli/README.md` — `Seat`, `defaultSeat` in the `Init` export row.
- `packages/agent/src/AgentSession.ts` — `launch` refuses a seatless prompt flow.
- `packages/control/src/ControlLive.ts` — `settleUnlaunched` and the
  `Control.run` error path; `LaunchFailed` imported as a value, `Cause` added.
- `docs/pages/installation.md` — one paragraph on the scaffold's seat. This is
  the getting-started page for rc.0; there is no `docs/pages/getting-started/`
  tree. `docs/pages/cli/init.md` is generated from `--help` and rc-contract
  section 4.1 and did not move: the verb's flags and its behavior sentence are
  unchanged, and `generate-docs-pages.mjs --check` confirms it.
- `docs/llms-core.txt`, `docs/llms-full.txt`, `packages/cli/docs/llms-full.txt`,
  `skills/smithers/llms-full.txt` — regenerated by `pnpm run docs:llms`.
- Tests: `packages/cli/test/{Init,Bin,EndToEnd}.test.ts`,
  `packages/control/test/{ControlContract.ts,ControlLiveList.test.ts}`,
  `packages/agent/test/{AgentSession,AgentSessionFailures}.test.ts`.
