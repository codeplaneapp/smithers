# Phase 7 gate: cli-e2e

Verdict: PASS

Every result below was taken in `migration/clean-checkout-4` at
`cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba` (`v1/rc0-migration`) on 2026-08-31,
05:00 to 05:15 PT. This file supersedes `cli-e2e-prev-20b32c6316.md`, taken
in `migration/clean-checkout-2` at `20b32c6316`; that file and its logs
(`cli-e2e-logs-prev-20b32c6316/`) stay beside this one for the diff.

## Scope

PLAN.md Phase 7 requires "CLI end-to-end tests using the working-tree CLI".
The task adds the negative gates: every unsupported or removed command in
`docs/migration/rc-contract.md` sections 4 and 5 must refuse with exit 1 and
the migration sentence, never a usage error and never a silent success.

Five layers of evidence, all from the clean checkout, all against real
`.flows/control.db` and `.flows/engine.db` SQLite files, no mocks:

1. The complete `@smthrs/cli` test suite (36 files, 626 tests). It contains
   `test/EndToEnd.test.ts` (real `smithers` processes against one real
   project: init, ls, plan parked with exit 3, detached up, `ps --status`,
   logs, two distinct signals, a cross-process approval decision, memory,
   steer, output, doctor, cancel, down, gc), `test/Bin.test.ts` (exit codes
   0/1/2/3/130/143, the help surface pinned to section 4.1, removed verbs and
   flags across the process boundary, reserved `system/*` flow ids, the
   SQLite-only contract including `SMITHERS_BACKEND`, the ignored PostgreSQL
   names, the 0.x database refusal, the served gateway mounts, the
   `--json`/`--quiet` stdout contract, the bin shim, the `--version`/`--help`
   fast path, section 6 detection, the migrate verb, `skills add`, and, new
   since the prior evidence, the attached-launch exit status of a run that
   settles `failed`), `test/Verb.test.ts` and `test/Unsupported.test.ts`
   (shipped set equals section 4.1, removed set equals section 4.2, every
   removed verb and flag through the real parser), `test/McpServer.test.ts`
   (11 supported tools, 10 unsupported envelopes, a real stdio round trip),
   plus CrossProcessCancel, Detached, Serve, Legacy, Doctor, Docs, Gc, Init,
   ControlSurface, and the rest.
2. A direct sweep of 127 negative and control invocations of
   `corepack pnpm exec smithers` from the checkout root: 101 removed-verb
   invocations (every plain verb, every removed group bare, and every
   subcommand of every removed group in the section 4.2 verb table, which
   includes the section 5.2 rows `hijack`, `pause`, and the time-travel
   verbs), 18 removed-flag invocations (every row of the section 4.2 flag
   table plus `--backend pglite`), the `--backend sqlite` no-op, the two
   surviving aliases, the usage-error control, and four environment gates.
3. A literal stdio round trip against `corepack pnpm exec smithers --mcp`:
   handshake, `tools/list`, one supported call, and all 10 unsupported tools.
4. Literal `corepack pnpm exec smithers ...` transcripts from the checkout
   root, plus an attached launch in a throwaway project whose run settles
   `failed` for real, with the SQLite rows read back by later processes.
5. `node scripts/check-local-smithers.mjs`, the guard that internal scripts
   execute the working tree and not a published copy.

The crash/restart fault suites under `e2e/faults` belong to the "real SQLite
persistence and crash/restart suites" gate, not this one.

## Environment

| Item | Value |
| --- | --- |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4` |
| HEAD | `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba` (`v1/rc0-migration`; `git status --porcelain` empty before and after) |
| Node | v24.18.0 (engines floor `>=22.19.0`) |
| pnpm | 11.21.0 via corepack 0.35.0 (`packageManager: pnpm@11.21.0`) |
| Bun | 1.4.0 (not used by this gate; the bin shim pins Node) |
| vitest | 4.1.9, v8 coverage enabled by `packages/cli/vitest.config.ts` |
| Date | 2026-08-31 05:00 to 05:15 PT |
| Host load | 1-minute load average 40 to 96 for the whole window. Other Phase 7 gate agents ran concurrently in sibling checkouts. |
| `SMITHERS_HOME` | unset for every invocation (`env -u SMITHERS_HOME`) |

Dependencies were installed by the clean-install gate (`00-clean-install.md`).
`corepack pnpm exec smithers` resolves through `node_modules/.bin/smithers` to
`packages/cli/bin/smithers.mjs`, which executes `src/bin.ts` because no `dist`
build exists in this checkout. `corepack pnpm exec smithers --version` from
the checkout root prints `smithers v1.0.0-rc.0`, exit 0.

Since the superseded evidence at `20b32c6316`, 20 commits landed; six touch
`packages/cli`: `4a803f193d` (attached launch exits with the run's terminal
status), `c9530978e3` (same for `run --resume`, `approve`, `deny`),
`fd05d15227` (`NoMatchingWait` rendered as a refusal), `ca22977386` (the
cli-lifecycle lane), `e9bf99e1a8` and `688bc1bc2a` (docs). `src/Command.ts`
gained `settlementStatus` and `reportSettlement` (0 completed, 1 failed, 130
cancelled, 3 waiting-approval) and a `Terminal` receipt short-circuit in
`awaitOwnedRun`; `src/bin.ts` routes the runtime logger to stderr
(`Logger.LogToStderr`) so `--json` stdout stays one document. The removal
surface (`src/Unsupported.ts`, `src/Verb.ts`, `test/Verb.test.ts`,
`test/Unsupported.test.ts`, `test/EndToEnd.test.ts`, `test/McpServer.test.ts`)
is byte-identical to the prior evidence. `test/Bin.test.ts` grew from 46 to 53
`it` blocks (the `an attached launch's exit status` describe and the `signal`
refusal case) and `test/ControlSurface.test.ts` from 13 to 16, which is why the
suite grew from 608 to 626 tests.

## 1. Full @smthrs/cli test suite: 36 files, 626 tests, exit 0

Command, run once from `packages/cli` in the clean checkout:

```
cd packages/cli && env -u SMITHERS_HOME corepack pnpm exec vitest run
```

Result (05:00:31 to 05:05:08 PT, load 59 at start, 42 at end, peak 76):

```
 RUN  v4.1.9 .../migration/clean-checkout-4/packages/cli
      Coverage enabled with v8
 Test Files  36 passed (36)
      Tests  626 passed (626)
   Start at  05:00:36
   Duration  271.93s (transform 86.85s, setup 0ms, import 175.32s, tests 495.16s, environment 9ms)
Statements   : 81.73% ( 1656/2026 )
Branches     : 78.52% ( 980/1248 )
Functions    : 76.44% ( 409/535 )
Lines        : 82.06% ( 1469/1790 )
EXIT=0
```

The coverage ratchet in `packages/cli/vitest.config.ts` (branches 76,
functions 72, lines 79, statements 78) passed. The wall-clock assertion at
`test/Bin.test.ts:138` that failed once in the prior evidence at load 31 to 33
passed in this run at load 42 to 76. Full log:
`cli-e2e-logs/cli-vitest-run1.log`.

## 2. Negative-gate sweep: 127 invocations, 127 ok

Every invocation ran `corepack pnpm exec smithers ...` from the clean checkout
root, eight at a time (`cli-e2e-logs/negative-sweep.mjs`, 05:05:21 to
05:11:38 PT, load 41 to 96). Each case checks the exit code and the exact
contract sentence in the combined output. Result:
`SWEEP-DONE PASS=127 FAIL=0 TOTAL=127`, exit 0.

- 101 removed-verb invocations: exit 1, message
  `smithers <verb> was removed in 1.0.0-rc.0: <reason>. See
  https://smithers.sh/migration/1.0#<anchor>`, with the sub-verb carried into
  the message for every removed group (`agents add`, `cron list`,
  `workflow run`, `gateway status`, `worktrees prune`, and so on).
- 18 removed-flag invocations on their surviving parents (`steer --takeover`;
  the 13 `up` flags including `--max-concurrency 4`; `migrate --to postgres`;
  `init example --global`; global `--backend postgres` and `--backend pglite`):
  exit 1. The two `--backend` rows fail with section 2's exact
  `unsupported_database` sentence; every other flag fails with the removal
  sentence.
- `--backend sqlite ls`: accepted as a no-op, exit 0.
- Surviving aliases `workflow list` and `ls`: exit 0.
- Control: `definitely-not-a-verb` exits 2 with `Unknown subcommand`, so a
  removed verb's exit 1 is a deliberate refusal, not the parser's usage error.
- Environment: `SMITHERS_BACKEND=pglite` and `SMITHERS_BACKEND=postgres` exit
  1 with `unsupported_database`; `SMITHERS_BACKEND=sqlite` is a no-op, exit 0;
  `SMITHERS_POSTGRES_URL` and `SMITHERS_TEST_PG_URL` print one `ignored:` line
  each on stderr and the command still exits 0.

Section 4.2 coverage, row by row: time travel and checkpoints (13 verbs plus
`worktrees`, `worktrees list`, `worktrees prune`); hijack and pause; old
gateway and UI hosting (`gateway status`, `gateway stop`, `ui`, `gui`,
`monitor`); supervision (`supervise`, `supervisor`, `top`); evaluation
(`eval`, `optimize`, `scores`); chat and narration (`chat`, `chat-create`,
`what`, `ask`); accounts and providers (`agents` and its 7 subcommands,
`usage`, `claude-shell`, `hermes`, `listeners`, `observability`, `alerts`,
`herdr` and 4, `openapi` and 2, `token` and 3, `cron` and 4); packs and
scaffolding (`make-workflow`, `starters`, `share`, `add`, `remove`, `eject`,
`upgrade`, `packs` and 2, `workflow` and its 6 removed subcommands); human
requests (`human`, `human list`, `human resolve`, `ask-human`); node detail
(`node`, `tail`); review and release (`review`, `release`, `test`); old
aliases and did-you-mean keys (all 12).

Section 5 coverage inside that set: `hijack` and `pause` (5.2 rows one and
two), `steer --takeover` (hijack enforcement), every time-travel verb
(`replay`, `rewind`, `fork`, `timetravel`, `snapshots`, `restore`,
`snapshot-hook`, `revert`, `timeline`, `diff`; 5.1 "Time travel" and X-19),
the checkpoint and worktree verbs (`worktrees list|prune`, `tree`, `graph`;
5.2 "Checkpoints and worktree lanes"), the supervision surface (`supervise`,
`supervisor`, `top`, the `up --force`/`--steal-ownership`/`--resume-*` flags;
5.2 "Supervisor process"), and the diff-review gate (`diff`; 5.2 "Diff-review
gate"). The remaining 5.2 rows (`interruptUnsafe`, `Continued`, quota wake,
`WakeBus`, detached children, edge engine, plan admission caps, orphan
reaping) are library behavior with no CLI verb and are outside this gate.

The removed set in `packages/cli/src/Unsupported.ts` was compared row by row
against the section 4.2 tables before the sweep ran; the two agree.

## 3. MCP stdio round trip: 21 tools, 10 unsupported envelopes

`node cli-e2e-logs/mcp-probe.mjs <checkout>` spawns
`corepack pnpm exec smithers --mcp` from the clean checkout root and speaks
newline-delimited JSON-RPC over stdio (05:05:36 to 05:05:59 PT). Exit 0,
`MCP-PROBE-DONE unsupported=10 bad=0`.

```
initialize -> {"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"smithers","version":"1.0.0-rc.0"}}
tools/list -> 21 tools: list_workflows, run_workflow, list_runs, get_run, watch_run, get_run_events, explain_run, list_pending_approvals, resolve_approval, get_node_detail, get_chat_transcript, revert_attempt, fork_run, replay_run, rewind_run, restore_checkpoint, list_snapshots, get_timeline, time_travel, list_artifacts, ask_human
tools/call list_workflows -> {"isError":false,"ok":true}
tools/call revert_attempt -> ok isError=true envelope={"ok":false,"error":{"code":"unsupported","message":"revert_attempt is not available in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and is not composed into the CLI. See https://smithers.sh/migration/1.0"}}
tools/call fork_run, replay_run, rewind_run, get_timeline, time_travel -> ok, same envelope shape and reason
tools/call restore_checkpoint, list_snapshots -> ok, reason "worktree lanes and snapshot restore are deferred"
tools/call list_artifacts -> ok, reason "the artifact projection is not part of this release"
tools/call ask_human -> ok isError=true envelope={"ok":false,"error":{"code":"unsupported","message":"ask_human is not available in 1.0.0-rc.0: there is no question or answer RPC; approvals park the run, so use list_pending_approvals. See https://smithers.sh/migration/1.0"}}
```

The 11 listed before `revert_attempt` are exactly section 4.1's supported
set; the 10 after are exactly its unsupported set. Full output with every
message: `cli-e2e-logs/mcp-probe.log`.

## 4. Literal transcripts

`cli-e2e-logs/cli-transcripts.sh` produced `cli-e2e-logs/cli-transcripts.txt`
(05:05:30 to 05:13:31 PT, `SCRIPT-EXIT=0`). The full file holds every
command's complete output, including the `ls`, `doctor`, and `--help`
documents.

### 4a. From the clean checkout root

```
$ corepack pnpm exec smithers --version
smithers v1.0.0-rc.0
exit=0

$ corepack pnpm exec smithers replay
smithers replay was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#replay
exit=1

$ corepack pnpm exec smithers pause
smithers pause was removed in 1.0.0-rc.0: not available; use `steer`, `signal`, `approve`, `deny`, `cancel`, `run --resume`. See https://smithers.sh/migration/1.0#pause
exit=1

$ corepack pnpm exec smithers hijack
smithers hijack was removed in 1.0.0-rc.0: not available; use `steer`, `signal`, `approve`, `deny`, `cancel`, `run --resume`. See https://smithers.sh/migration/1.0#hijack
exit=1

$ corepack pnpm exec smithers agents add
smithers agents add was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#agents
exit=1

$ corepack pnpm exec smithers worktrees prune
smithers worktrees prune was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#worktrees
exit=1

$ corepack pnpm exec smithers gateway status
smithers gateway status was removed in 1.0.0-rc.0: replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted. See https://smithers.sh/migration/1.0#gateway
exit=1

$ corepack pnpm exec smithers human list
smithers human list was removed in 1.0.0-rc.0: approvals park the run; use `ps --status waiting-approval`, `approve`, and `deny`. See https://smithers.sh/migration/1.0#human
exit=1

$ corepack pnpm exec smithers docs-full
smithers docs-full was removed in 1.0.0-rc.0: `docs-full` becomes `docs --full`. See https://smithers.sh/migration/1.0#docs-full
exit=1

$ corepack pnpm exec smithers steer run-1 --message hello --takeover
smithers steer --takeover was removed in 1.0.0-rc.0: hijack is not available; `steer --message` is the only mode. See https://smithers.sh/migration/1.0#hijack
exit=1

$ corepack pnpm exec smithers up system/test --max-concurrency 4
smithers up --max-concurrency was removed in 1.0.0-rc.0: parallelism is declared by the flow and bounded by plan admission. See https://smithers.sh/migration/1.0#plan-admission
exit=1

$ corepack pnpm exec smithers up system/test --serve
smithers up --serve was removed in 1.0.0-rc.0: replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted. See https://smithers.sh/migration/1.0#ui
exit=1

$ corepack pnpm exec smithers migrate --to pglite
smithers migrate --to was removed in 1.0.0-rc.0: SQLite only; the 0.x database move is removed. See https://smithers.sh/migration/1.0#databases
exit=1

$ corepack pnpm exec smithers init example --global
smithers init --global was removed in 1.0.0-rc.0: rc.0 has no global pack; seats resolve from environment keys. See https://smithers.sh/migration/1.0#init
exit=1

$ corepack pnpm exec smithers --backend postgres ls
unsupported_database: 1.0.0-rc.0 supports local SQLite only. PostgreSQL and PGlite are not available. Unset SMITHERS_BACKEND or set it to sqlite. See https://smithers.sh/migration/1.0#databases
exit=1

$ corepack pnpm exec smithers --backend sqlite ps
{ "_tag": "runs", "items": [] }
exit=0

$ env SMITHERS_BACKEND=pglite corepack pnpm exec smithers ls
unsupported_database: ... (same sentence)
exit=1

$ env SMITHERS_POSTGRES_URL=postgres://x SMITHERS_TEST_PG_URL=postgres://y corepack pnpm exec smithers ps
ignored: SMITHERS_POSTGRES_URL has no effect in 1.0.0-rc.0 (SQLite only)
ignored: SMITHERS_TEST_PG_URL has no effect in 1.0.0-rc.0 (SQLite only)
{ "_tag": "runs", "items": [] }
exit=0

$ corepack pnpm exec smithers definitely-not-a-verb
[help text, then:]
ERROR
  Unknown subcommand "definitely-not-a-verb" for "smithers"
exit=2

$ corepack pnpm exec smithers plan system/test
smithers plan system/test: system/test is a reserved system flow id and carries no body in 1.0.0-rc.0, so a launch would park with nothing to run. Name a flow from `smithers ls`. See https://smithers.sh/migration/1.0#flows
exit=1

$ corepack pnpm exec smithers up system/test
smithers up system/test: system/test is a reserved system flow id ... (same sentence)
exit=1
```

`corepack pnpm exec smithers --help` (exit 0, `cli-e2e-logs/cli-help.txt`)
lists exactly the 26 section 4.1 subcommands (`plan`, `run`, `up`, `approve`,
`deny`, `cancel`, `signal`, `steer`, `ls`, `ps`, `status, inspect`, `logs`,
`output`, `down`, `serve`, `init`, `doctor`, `docs`, `gc`, `migrate`,
`memory`, `claude`, `mcp`, `skills`, `update`, `bug`) plus the built-in
`--completions`, and advertises no removed verb.

### 4b. Attached launch exit status against a real failed run

A throwaway project outside the checkout holds one flow, `flows/failing/flow.mdx`,
declaring `model: openai:gpt-5-mini`. `SMITHERS_OPENAI_AUTH=chatgpt` routes
that seat to the codex credential store and `CODEX_HOME` points at a store
whose `auth.json` is `{}`: the seat resolves, the launch is accepted, and the
first turn fails locally reading the token. No network, no provider, and a
real `control.run.failed` settlement (the same fixture `test/Bin.test.ts`
uses). The working-tree bin `packages/cli/bin/smithers.mjs` was run from that
project directory.

```
$ node --no-warnings <checkout>/packages/cli/bin/smithers.mjs up failing --json
stdout (1 line): {"_tag":"Accepted","receiptId":"approve:plan-1","runId":"run-1"}
stderr (29 lines): [05:13:21.671] WARN (#219): An agent run failed { runId: 'run-1', cause: '/harness/HarnessError: The cell frame failed ...
exit=1

$ ... ps --json
{"_tag":"runs","items":[{"createdAt":1788178401314,"flowId":"failing","planDigest":"c0df27f6...","planId":"plan-1","runId":"run-1","status":"failed","steering":{"pending":0},"updatedAt":1788178401673}]}
exit=0

$ ... run --resume run-1 --json
{"_tag":"Terminal","runId":"run-1","status":"failed"}
exit=1

$ ... status run-1
Verdict   failed — /harness/HarnessError: The cell frame failed
Run       run-1 · failing · openai:gpt-5-mini · 0s
Activity  1 turns · 0 calls (0 refused, 0 duplicate) · edits 0/0
Next      smithers logs run-1    # turn-by-turn transcript
exit=0

$ ... cancel run-1 --json
{"_tag":"Terminal","runId":"run-1","status":"failed"}
exit=0

$ ... signal run-1 '{"name":"go","payload":{}}'
{ "_tag": "Terminal", "runId": "run-1", "status": "failed" }
exit=0

$ ... logs run-1 --json   (second staging of the same fixture)
11 events: control.run.accepted, control.run.running, flows.engine.run-decision x2,
flows.engine.attempt-started, flows.engine.snapshot-identified,
flows.engine.attempt-finished, control.agent.discipline-armed,
control.agent.turn-opened, control.run.failed, flows.engine.run-decision

SQLite rows read back by a separate Node process (node:sqlite, read-only):
engine.db flows_runs:       {"run_id":"run-1","status":"failed","finished":1}
engine.db run-decisions:    ["created","claimed-and-activated","transitioned"]
engine.db flows_journal_events by type: control.agent.discipline-armed 1, control.agent.turn-opened 1,
  control.approval.approved 1, control.plan.created 1, control.run.accepted 1, control.run.failed 1,
  control.run.running 1, flows.engine.attempt-finished 1, flows.engine.attempt-started 1,
  flows.engine.run-decision 3, flows.engine.snapshot-identified 1
control.db flows_journal_events: 0 rows (see section 6)
```

This is the section 4.1 `up` row ("exit code follows the terminal status")
and the `run --resume` row ("including the status a `Terminal` receipt
reports") observed at the process boundary: exit 1 for `failed`, one JSON
document on stdout, diagnostics on stderr, the control plane and the engine
row both `failed`, and no `interrupt-released` or `stolen-and-activated`
decision. A cancel or signal against the terminal run returns the `Terminal`
receipt (section 5.1 "Cancel") and writes no event.

## 5. Working-tree guard and checkout integrity

```
$ node scripts/check-local-smithers.mjs
check-local-smithers: internal scripts run the Smithers working tree
exit=0
```

`git status --porcelain` in the clean checkout is empty after all runs. The
only state the runs created is the git-ignored `.flows/` directory at the
checkout root (`cache/` existed from an earlier gate; `control.db` and
`engine.db` were added by the `ls` and `ps` invocations here). No fix was
applied in the clean checkout.

## 6. Follow-up for a fix lane (advisory, not a blocker)

`packages/cli/test/Bin.test.ts:1124-1132` `turnsOpened` counts
`control.agent.turn-opened` rows in `.flows/control.db`
`flows_journal_events`. Under the CLI composition every journal row, control
and engine alike, is written to `.flows/engine.db` (`NodeControl.ts:390`,
`:1073`; the table listing above), so `control.db`'s `flows_journal_events`
holds 0 rows and the assertion at `:1180`
(`expect(turnsOpened(cwd, runId)).toBe(turns)`) compares 0 with 0. The
sibling helper `engineDecisions` at `:1097` reads `engine.db` and carries the
same pin correctly (`decisions` equal before and after, no
`stolen-and-activated`), so the contract is still covered. The fix is to point
`turnsOpened` at `engine.db` and assert `turns` is 1 after the first launch,
so the helper measures the turn it names. Ownership:
`packages/cli/test/Bin.test.ts`.

The wall-clock assertions at `test/Bin.test.ts:114` and `:138`
(`elapsed < 5000 ms` around a real `--version` / `--help` process) passed
this run at load 42 to 76. The prior evidence recorded one failure at load
31 to 33 inside the coverage-instrumented suite; the assertion still measures
host speed and the recommendation there stands.

## Raw logs

`cli-e2e-logs/` beside this file: `cli-vitest-run1.log`,
`negative-sweep.mjs`, `negative-sweep.log`, `negative-sweep.tsv`,
`mcp-probe.mjs`, `mcp-probe.log`, `cli-transcripts.sh`, `cli-transcripts.txt`,
`cli-help.txt`. The superseded run is in `cli-e2e-logs-prev-20b32c6316/`.

## Appendix: full sweep results

One line per invocation: verdict, label, exit code, invocation, first output
line. Produced by `cli-e2e-logs/negative-sweep.mjs`.

```
ok	alias: ls	exit=0	smithers ls	{
ok	alias: workflow list	exit=0	smithers workflow list	{
ok	control: unknown verb exits 2	exit=2	smithers definitely-not-a-verb	DESCRIPTION
ok	env: PG urls ignored	exit=0	SMITHERS_POSTGRES_URL=postgres://x SMITHERS_TEST_PG_URL=postgres://y smithers ls	ignored: SMITHERS_POSTGRES_URL has no effect in 1.0.0-rc.0 (SQLite only)
ok	env: SMITHERS_BACKEND=pglite	exit=1	SMITHERS_BACKEND=pglite smithers ls	unsupported_database: 1.0.0-rc.0 supports local SQLite only. PostgreSQL and PGlite are not available. Unset SMITHERS_BACKEND or set it to sqlite. See https://smithers.sh/migration/1.0#databases
ok	env: SMITHERS_BACKEND=postgres	exit=1	SMITHERS_BACKEND=postgres smithers ls	unsupported_database: 1.0.0-rc.0 supports local SQLite only. PostgreSQL and PGlite are not available. Unset SMITHERS_BACKEND or set it to sqlite. See https://smithers.sh/migration/1.0#databases
ok	env: SMITHERS_BACKEND=sqlite no-op	exit=0	SMITHERS_BACKEND=sqlite smithers ls	{
ok	flag: --backend pglite	exit=1	smithers --backend pglite ls	unsupported_database: 1.0.0-rc.0 supports local SQLite only. PostgreSQL and PGlite are not available. Unset SMITHERS_BACKEND or set it to sqlite. See https://smithers.sh/migration/1.0#databases
ok	flag: --backend postgres	exit=1	smithers --backend postgres ls	unsupported_database: 1.0.0-rc.0 supports local SQLite only. PostgreSQL and PGlite are not available. Unset SMITHERS_BACKEND or set it to sqlite. See https://smithers.sh/migration/1.0#databases
ok	flag: init --global	exit=1	smithers init example --global	smithers init --global was removed in 1.0.0-rc.0: rc.0 has no global pack; seats resolve from environment keys. See https://smithers.sh/migration/1.0#init
ok	flag: migrate --to	exit=1	smithers migrate --to postgres	smithers migrate --to was removed in 1.0.0-rc.0: SQLite only; the 0.x database move is removed. See https://smithers.sh/migration/1.0#databases
ok	flag: steer --takeover	exit=1	smithers steer run-1 --message hello --takeover	smithers steer --takeover was removed in 1.0.0-rc.0: hijack is not available; `steer --message` is the only mode. See https://smithers.sh/migration/1.0#hijack
ok	flag: up --force	exit=1	smithers up system/test --force	smithers up --force was removed in 1.0.0-rc.0: the run driver's heartbeat sweep owns recovery. See https://smithers.sh/migration/1.0#supervision
ok	flag: up --herdr	exit=1	smithers up system/test --herdr	smithers up --herdr was removed in 1.0.0-rc.0: replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted. See https://smithers.sh/migration/1.0#ui
ok	flag: up --interactive	exit=1	smithers up system/test --interactive	smithers up --interactive was removed in 1.0.0-rc.0: replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted. See https://smithers.sh/migration/1.0#ui
ok	flag: up --max-concurrency	exit=1	smithers up system/test --max-concurrency 4	smithers up --max-concurrency was removed in 1.0.0-rc.0: parallelism is declared by the flow and bounded by plan admission. See https://smithers.sh/migration/1.0#plan-admission
ok	flag: up --monitor	exit=1	smithers up system/test --monitor	smithers up --monitor was removed in 1.0.0-rc.0: replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted. See https://smithers.sh/migration/1.0#ui
ok	flag: up --report	exit=1	smithers up system/test --report	smithers up --report was removed in 1.0.0-rc.0: replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted. See https://smithers.sh/migration/1.0#ui
ok	flag: up --resume-claim-heartbeat	exit=1	smithers up system/test --resume-claim-heartbeat	smithers up --resume-claim-heartbeat was removed in 1.0.0-rc.0: the run driver's heartbeat sweep owns recovery. See https://smithers.sh/migration/1.0#supervision
ok	flag: up --resume-claim-owner	exit=1	smithers up system/test --resume-claim-owner	smithers up --resume-claim-owner was removed in 1.0.0-rc.0: the run driver's heartbeat sweep owns recovery. See https://smithers.sh/migration/1.0#supervision
ok	flag: up --resume-restore-heartbeat	exit=1	smithers up system/test --resume-restore-heartbeat	smithers up --resume-restore-heartbeat was removed in 1.0.0-rc.0: the run driver's heartbeat sweep owns recovery. See https://smithers.sh/migration/1.0#supervision
ok	flag: up --resume-restore-owner	exit=1	smithers up system/test --resume-restore-owner	smithers up --resume-restore-owner was removed in 1.0.0-rc.0: the run driver's heartbeat sweep owns recovery. See https://smithers.sh/migration/1.0#supervision
ok	flag: up --serve	exit=1	smithers up system/test --serve	smithers up --serve was removed in 1.0.0-rc.0: replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted. See https://smithers.sh/migration/1.0#ui
ok	flag: up --steal-ownership	exit=1	smithers up system/test --steal-ownership	smithers up --steal-ownership was removed in 1.0.0-rc.0: the run driver's heartbeat sweep owns recovery. See https://smithers.sh/migration/1.0#supervision
ok	flag: up --supervise	exit=1	smithers up system/test --supervise	smithers up --supervise was removed in 1.0.0-rc.0: replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted. See https://smithers.sh/migration/1.0#ui
ok	no-op: --backend sqlite ls	exit=0	smithers --backend sqlite ls	{
ok	removed: add	exit=1	smithers add	smithers add was removed in 1.0.0-rc.0: JSX pack tooling is gone; `smithers migrate` replaces `upgrade`. See https://smithers.sh/migration/1.0#add
ok	removed: agents	exit=1	smithers agents	smithers agents was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#agents
ok	removed: agents add	exit=1	smithers agents add	smithers agents add was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#agents
ok	removed: agents capabilities	exit=1	smithers agents capabilities	smithers agents capabilities was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#agents
ok	removed: agents doctor	exit=1	smithers agents doctor	smithers agents doctor was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#agents
ok	removed: agents list	exit=1	smithers agents list	smithers agents list was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#agents
ok	removed: agents reauth	exit=1	smithers agents reauth	smithers agents reauth was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#agents
ok	removed: agents remove	exit=1	smithers agents remove	smithers agents remove was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#agents
ok	removed: agents test	exit=1	smithers agents test	smithers agents test was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#agents
ok	removed: alerts	exit=1	smithers alerts	smithers alerts was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#alerts
ok	removed: ask	exit=1	smithers ask	smithers ask was removed in 1.0.0-rc.0: removed with the JSX inline workflow. See https://smithers.sh/migration/1.0#ask
ok	removed: ask-human	exit=1	smithers ask-human	smithers ask-human was removed in 1.0.0-rc.0: approvals park the run; use `ps --status waiting-approval`, `approve`, and `deny`. See https://smithers.sh/migration/1.0#ask-human
ok	removed: chat	exit=1	smithers chat	smithers chat was removed in 1.0.0-rc.0: removed with the JSX inline workflow. See https://smithers.sh/migration/1.0#chat
ok	removed: chat-create	exit=1	smithers chat-create	smithers chat-create was removed in 1.0.0-rc.0: removed with the JSX inline workflow. See https://smithers.sh/migration/1.0#chat-create
ok	removed: claude-shell	exit=1	smithers claude-shell	smithers claude-shell was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#claude-shell
ok	removed: cron	exit=1	smithers cron	smithers cron was removed in 1.0.0-rc.0: moved to the plugins repository or deferred (cron returns on @smthrs/triggers). See https://smithers.sh/migration/1.0#cron
ok	removed: cron add	exit=1	smithers cron add	smithers cron add was removed in 1.0.0-rc.0: moved to the plugins repository or deferred (cron returns on @smthrs/triggers). See https://smithers.sh/migration/1.0#cron
ok	removed: cron list	exit=1	smithers cron list	smithers cron list was removed in 1.0.0-rc.0: moved to the plugins repository or deferred (cron returns on @smthrs/triggers). See https://smithers.sh/migration/1.0#cron
ok	removed: cron rm	exit=1	smithers cron rm	smithers cron rm was removed in 1.0.0-rc.0: moved to the plugins repository or deferred (cron returns on @smthrs/triggers). See https://smithers.sh/migration/1.0#cron
ok	removed: cron start	exit=1	smithers cron start	smithers cron start was removed in 1.0.0-rc.0: moved to the plugins repository or deferred (cron returns on @smthrs/triggers). See https://smithers.sh/migration/1.0#cron
ok	removed: diff	exit=1	smithers diff	smithers diff was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#diff
ok	removed: docs-full	exit=1	smithers docs-full	smithers docs-full was removed in 1.0.0-rc.0: `docs-full` becomes `docs --full`. See https://smithers.sh/migration/1.0#docs-full
ok	removed: eject	exit=1	smithers eject	smithers eject was removed in 1.0.0-rc.0: JSX pack tooling is gone; `smithers migrate` replaces `upgrade`. See https://smithers.sh/migration/1.0#eject
ok	removed: eval	exit=1	smithers eval	smithers eval was removed in 1.0.0-rc.0: not part of the engine release. See https://smithers.sh/migration/1.0#eval
ok	removed: exec	exit=1	smithers exec	smithers exec was removed in 1.0.0-rc.0: use `up`. See https://smithers.sh/migration/1.0#exec
ok	removed: fork	exit=1	smithers fork	smithers fork was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#fork
ok	removed: gateway status	exit=1	smithers gateway status	smithers gateway status was removed in 1.0.0-rc.0: replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted. See https://smithers.sh/migration/1.0#gateway
ok	removed: gateway stop	exit=1	smithers gateway stop	smithers gateway stop was removed in 1.0.0-rc.0: replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted. See https://smithers.sh/migration/1.0#gateway
ok	removed: graph	exit=1	smithers graph	smithers graph was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#graph
ok	removed: gui	exit=1	smithers gui	smithers gui was removed in 1.0.0-rc.0: replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted. See https://smithers.sh/migration/1.0#gui
ok	removed: help	exit=1	smithers help	smithers help was removed in 1.0.0-rc.0: use `--help`. See https://smithers.sh/migration/1.0#help
ok	removed: herdr	exit=1	smithers herdr	smithers herdr was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#herdr
ok	removed: herdr attach	exit=1	smithers herdr attach	smithers herdr attach was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#herdr
ok	removed: herdr clean	exit=1	smithers herdr clean	smithers herdr clean was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#herdr
ok	removed: herdr open	exit=1	smithers herdr open	smithers herdr open was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#herdr
ok	removed: herdr status	exit=1	smithers herdr status	smithers herdr status was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#herdr
ok	removed: hermes	exit=1	smithers hermes	smithers hermes was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#hermes
ok	removed: hijack	exit=1	smithers hijack	smithers hijack was removed in 1.0.0-rc.0: not available; use `steer`, `signal`, `approve`, `deny`, `cancel`, `run --resume`. See https://smithers.sh/migration/1.0#hijack
ok	removed: human	exit=1	smithers human	smithers human was removed in 1.0.0-rc.0: approvals park the run; use `ps --status waiting-approval`, `approve`, and `deny`. See https://smithers.sh/migration/1.0#human
ok	removed: human list	exit=1	smithers human list	smithers human list was removed in 1.0.0-rc.0: approvals park the run; use `ps --status waiting-approval`, `approve`, and `deny`. See https://smithers.sh/migration/1.0#human
ok	removed: human resolve	exit=1	smithers human resolve	smithers human resolve was removed in 1.0.0-rc.0: approvals park the run; use `ps --status waiting-approval`, `approve`, and `deny`. See https://smithers.sh/migration/1.0#human
ok	removed: kill	exit=1	smithers kill	smithers kill was removed in 1.0.0-rc.0: use `cancel`. See https://smithers.sh/migration/1.0#kill
ok	removed: list	exit=1	smithers list	smithers list was removed in 1.0.0-rc.0: use `ls`. See https://smithers.sh/migration/1.0#list
ok	removed: list-runs	exit=1	smithers list-runs	smithers list-runs was removed in 1.0.0-rc.0: use `ps`. See https://smithers.sh/migration/1.0#list-runs
ok	removed: listeners	exit=1	smithers listeners	smithers listeners was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#listeners
ok	removed: log	exit=1	smithers log	smithers log was removed in 1.0.0-rc.0: use `logs`. See https://smithers.sh/migration/1.0#log
ok	removed: make-workflow	exit=1	smithers make-workflow	smithers make-workflow was removed in 1.0.0-rc.0: JSX pack tooling is gone; `smithers migrate` replaces `upgrade`. See https://smithers.sh/migration/1.0#make-workflow
ok	removed: monitor	exit=1	smithers monitor	smithers monitor was removed in 1.0.0-rc.0: replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted. See https://smithers.sh/migration/1.0#monitor
ok	removed: node	exit=1	smithers node	smithers node was removed in 1.0.0-rc.0: use `output`, `logs --json`, and the node-output projection. See https://smithers.sh/migration/1.0#node
ok	removed: observability	exit=1	smithers observability	smithers observability was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#observability
ok	removed: openapi	exit=1	smithers openapi	smithers openapi was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#openapi
ok	removed: openapi generate	exit=1	smithers openapi generate	smithers openapi generate was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#openapi
ok	removed: openapi list	exit=1	smithers openapi list	smithers openapi list was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#openapi
ok	removed: optimize	exit=1	smithers optimize	smithers optimize was removed in 1.0.0-rc.0: not part of the engine release. See https://smithers.sh/migration/1.0#optimize
ok	removed: packs	exit=1	smithers packs	smithers packs was removed in 1.0.0-rc.0: JSX pack tooling is gone; `smithers migrate` replaces `upgrade`. See https://smithers.sh/migration/1.0#packs
ok	removed: packs list	exit=1	smithers packs list	smithers packs list was removed in 1.0.0-rc.0: JSX pack tooling is gone; `smithers migrate` replaces `upgrade`. See https://smithers.sh/migration/1.0#packs
ok	removed: packs update	exit=1	smithers packs update	smithers packs update was removed in 1.0.0-rc.0: JSX pack tooling is gone; `smithers migrate` replaces `upgrade`. See https://smithers.sh/migration/1.0#packs
ok	removed: pause	exit=1	smithers pause	smithers pause was removed in 1.0.0-rc.0: not available; use `steer`, `signal`, `approve`, `deny`, `cancel`, `run --resume`. See https://smithers.sh/migration/1.0#pause
ok	removed: release	exit=1	smithers release	smithers release was removed in 1.0.0-rc.0: not an rc.0 verb. See https://smithers.sh/migration/1.0#release
ok	removed: remove	exit=1	smithers remove	smithers remove was removed in 1.0.0-rc.0: JSX pack tooling is gone; `smithers migrate` replaces `upgrade`. See https://smithers.sh/migration/1.0#remove
ok	removed: replay	exit=1	smithers replay	smithers replay was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#replay
ok	removed: restore	exit=1	smithers restore	smithers restore was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#restore
ok	removed: retry-task	exit=1	smithers retry-task	smithers retry-task was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#retry-task
ok	removed: revert	exit=1	smithers revert	smithers revert was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#revert
ok	removed: review	exit=1	smithers review	smithers review was removed in 1.0.0-rc.0: not an rc.0 verb. See https://smithers.sh/migration/1.0#review
ok	removed: rewind	exit=1	smithers rewind	smithers rewind was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#rewind
ok	removed: runs	exit=1	smithers runs	smithers runs was removed in 1.0.0-rc.0: use `ps`. See https://smithers.sh/migration/1.0#runs
ok	removed: scores	exit=1	smithers scores	smithers scores was removed in 1.0.0-rc.0: not part of the engine release. See https://smithers.sh/migration/1.0#scores
ok	removed: share	exit=1	smithers share	smithers share was removed in 1.0.0-rc.0: JSX pack tooling is gone; `smithers migrate` replaces `upgrade`. See https://smithers.sh/migration/1.0#share
ok	removed: show	exit=1	smithers show	smithers show was removed in 1.0.0-rc.0: use `status`. See https://smithers.sh/migration/1.0#show
ok	removed: snapshot-hook	exit=1	smithers snapshot-hook	smithers snapshot-hook was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#snapshot-hook
ok	removed: snapshots	exit=1	smithers snapshots	smithers snapshots was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#snapshots
ok	removed: start	exit=1	smithers start	smithers start was removed in 1.0.0-rc.0: use `up`. See https://smithers.sh/migration/1.0#start
ok	removed: starters	exit=1	smithers starters	smithers starters was removed in 1.0.0-rc.0: JSX pack tooling is gone; `smithers migrate` replaces `upgrade`. See https://smithers.sh/migration/1.0#starters
ok	removed: stop	exit=1	smithers stop	smithers stop was removed in 1.0.0-rc.0: use `cancel`. See https://smithers.sh/migration/1.0#stop
ok	removed: supervise	exit=1	smithers supervise	smithers supervise was removed in 1.0.0-rc.0: the run driver's heartbeat sweep owns recovery. See https://smithers.sh/migration/1.0#supervise
ok	removed: supervisor	exit=1	smithers supervisor	smithers supervisor was removed in 1.0.0-rc.0: the run driver's heartbeat sweep owns recovery. See https://smithers.sh/migration/1.0#supervisor
ok	removed: tail	exit=1	smithers tail	smithers tail was removed in 1.0.0-rc.0: use `output`, `logs --json`, and the node-output projection. See https://smithers.sh/migration/1.0#tail
ok	removed: test	exit=1	smithers test	smithers test was removed in 1.0.0-rc.0: not an rc.0 verb. See https://smithers.sh/migration/1.0#test
ok	removed: timeline	exit=1	smithers timeline	smithers timeline was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#timeline
ok	removed: timetravel	exit=1	smithers timetravel	smithers timetravel was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#timetravel
ok	removed: token	exit=1	smithers token	smithers token was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#token
ok	removed: token exec	exit=1	smithers token exec	smithers token exec was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#token
ok	removed: token issue	exit=1	smithers token issue	smithers token issue was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#token
ok	removed: token revoke	exit=1	smithers token revoke	smithers token revoke was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#token
ok	removed: top	exit=1	smithers top	smithers top was removed in 1.0.0-rc.0: the run driver's heartbeat sweep owns recovery. See https://smithers.sh/migration/1.0#top
ok	removed: tree	exit=1	smithers tree	smithers tree was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#tree
ok	removed: ui	exit=1	smithers ui	smithers ui was removed in 1.0.0-rc.0: replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted. See https://smithers.sh/migration/1.0#ui
ok	removed: upgrade	exit=1	smithers upgrade	smithers upgrade was removed in 1.0.0-rc.0: JSX pack tooling is gone; `smithers migrate` replaces `upgrade`. See https://smithers.sh/migration/1.0#upgrade
ok	removed: usage	exit=1	smithers usage	smithers usage was removed in 1.0.0-rc.0: moved to the plugins repository or deferred. See https://smithers.sh/migration/1.0#usage
ok	removed: what	exit=1	smithers what	smithers what was removed in 1.0.0-rc.0: removed with the JSX inline workflow. See https://smithers.sh/migration/1.0#what
ok	removed: workflow create	exit=1	smithers workflow create	smithers workflow create was removed in 1.0.0-rc.0: JSX pack tooling is gone; `smithers migrate` replaces `upgrade`. See https://smithers.sh/migration/1.0#workflow
ok	removed: workflow doctor	exit=1	smithers workflow doctor	smithers workflow doctor was removed in 1.0.0-rc.0: JSX pack tooling is gone; `smithers migrate` replaces `upgrade`. See https://smithers.sh/migration/1.0#workflow
ok	removed: workflow inspect	exit=1	smithers workflow inspect	smithers workflow inspect was removed in 1.0.0-rc.0: JSX pack tooling is gone; `smithers migrate` replaces `upgrade`. See https://smithers.sh/migration/1.0#workflow
ok	removed: workflow path	exit=1	smithers workflow path	smithers workflow path was removed in 1.0.0-rc.0: JSX pack tooling is gone; `smithers migrate` replaces `upgrade`. See https://smithers.sh/migration/1.0#workflow
ok	removed: workflow run	exit=1	smithers workflow run	smithers workflow run was removed in 1.0.0-rc.0: JSX pack tooling is gone; `smithers migrate` replaces `upgrade`. See https://smithers.sh/migration/1.0#workflow
ok	removed: workflow skills	exit=1	smithers workflow skills	smithers workflow skills was removed in 1.0.0-rc.0: JSX pack tooling is gone; `smithers migrate` replaces `upgrade`. See https://smithers.sh/migration/1.0#workflow
ok	removed: workflows	exit=1	smithers workflows	smithers workflows was removed in 1.0.0-rc.0: use `ls`. See https://smithers.sh/migration/1.0#workflows
ok	removed: worktrees	exit=1	smithers worktrees	smithers worktrees was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#worktrees
ok	removed: worktrees list	exit=1	smithers worktrees list	smithers worktrees list was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#worktrees
ok	removed: worktrees prune	exit=1	smithers worktrees prune	smithers worktrees prune was removed in 1.0.0-rc.0: time travel is a library API (@smthrs/time-travel) and worktree lanes are deferred. See https://smithers.sh/migration/1.0#worktrees
PASS=127 FAIL=0
```
