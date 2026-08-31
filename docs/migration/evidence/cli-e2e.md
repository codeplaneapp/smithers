# Phase 7 gate: cli-e2e

Verdict: PASS

## Scope

PLAN.md Phase 7 requires "CLI end-to-end tests using the working-tree CLI".
The task adds the negative gates: every unsupported or removed command in
`docs/migration/rc-contract.md` sections 4 and 5 must refuse with exit 1 and
the migration sentence, never a usage error or a silent success.

Three layers of evidence, all from the clean checkout:

1. The complete `@smthrs/cli` test suite (36 files, 605 tests), which contains
   the end-to-end suite `test/EndToEnd.test.ts` (real `smithers` processes
   against one real project: init, ls, plan, detached up, ps --status, logs,
   two distinct signals, a cross-process approval decision, memory, steer,
   output, doctor, cancel, down, gc, all against real
   `.flows/control.db`/`.flows/engine.db` SQLite files), the process-boundary
   suite `test/Bin.test.ts` (exit codes 0/1/2/130/143, the help surface pinned
   to section 4.1, removed verbs and flags across the process boundary, the
   SQLite-only database contract including `SMITHERS_BACKEND`, the ignored
   PostgreSQL names, the 0.x database-file refusal, the served gateway mounts,
   the `--json`/`--quiet` stdout contract, the bin shim dist/src selection,
   0.x detection and the migrate verb), the surface pins `test/Verb.test.ts`
   (shipped set equals section 4.1; removed set equals section 4.2) and
   `test/Unsupported.test.ts` (every removed verb and flag through the real
   parser), and `test/McpServer.test.ts` (the 11 supported MCP tools, the 10
   unsupported tools answering `{ ok: false, error: { code: "unsupported" } }`,
   and a real stdio round trip), plus CrossProcessCancel, Detached, Serve,
   Legacy, Doctor, Docs, Gc, Init, and the rest.
2. A direct sweep of all 122 negative and control invocations of the
   working-tree CLI: 101 removed-verb invocations (every plain verb, every
   removed group bare, and every subcommand of every removed group in the
   section 4.2 verb table, which includes the section 5.2 rows `hijack`,
   `pause`, and the time-travel verbs), 18 removed-flag invocations (every row
   of the section 4.2 flag table, plus `--backend pglite`), the
   `--backend sqlite` no-op, and the 2 surviving aliases (`workflow list`,
   `ls`).
3. Literal `corepack pnpm exec smithers ...` transcripts for a representative
   subset, plus the environment-variable gates (`SMITHERS_BACKEND`,
   `SMITHERS_POSTGRES_URL`, `SMITHERS_TEST_PG_URL`) and the usage-error
   control (`definitely-not-a-verb` exits 2, distinct from removals).

The crash/restart fault suites under `e2e/faults` belong to the "real SQLite
persistence and crash/restart suites" gate, not this one.

## Environment

| Item | Value |
| --- | --- |
| Checkout | /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout |
| HEAD | `9c464343f0cfada6aa36f0a08144ed7cf1f0ce14` (`v1/rc0-migration`) |
| Node | v24.18.0 (engines floor `>=22.19.0`) |
| pnpm (corepack 0.35.0, `packageManager: pnpm@11.21.0`) | 11.21.0 |
| Bun | 1.4.0 (not used by this gate) |
| vitest | 4.1.9, v8 coverage enabled by `packages/cli/vitest.config.ts` |
| Date | 2026-08-30 |
| Host load | 1-minute load average 19-69 during the runs (other agent sessions on this machine); every result below was green regardless |

Dependencies were installed by the clean-install gate (`00-clean-install.md`).
The working-tree CLI resolves through `node_modules/.bin/smithers` to
`packages/cli/bin/smithers.mjs`, which executes `src/bin.ts` because no `dist`
build exists in this checkout; `corepack pnpm exec smithers --version` from
the checkout root prints `smithers v1.0.0-rc.0`, exit 0.

## 1. Full @smthrs/cli test suite

```
cd packages/cli && corepack pnpm exec vitest run
```

Exit code: 0. Final output lines:

```
 Test Files  36 passed (36)
      Tests  605 passed (605)
   Start at  15:50:48
   Duration  120.44s (transform 67.07s, setup 0ms, import 138.63s, tests 233.58s, environment 4ms)
Statements   : 81.77% ( 1633/1997 )
Branches     : 78.6% ( 966/1229 )
Functions    : 76.41% ( 405/530 )
Lines        : 82.02% ( 1447/1764 )
```

The coverage ratchet in `packages/cli/vitest.config.ts` (branches 76,
functions 72, lines 79, statements 78) passed. Full log:
`/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/cli-vitest.log`.

## 2. Negative-gate sweep: 122 invocations, 122 ok

Every invocation ran the working-tree CLI from the clean checkout root
(`node_modules/.bin/smithers`, the identical shim `pnpm exec smithers`
resolves; six invocations in parallel for wall time on the loaded host). Each
case checks both the exit code and the exact contract sentence in the output.
Result: `SWEEP-DONE 122 ok / 122 total`, zero failures.

- 101 removed-verb invocations: exit 1, message
  `smithers <verb> was removed in 1.0.0-rc.0: <reason>. See
  https://smithers.sh/migration/1.0#<anchor>`, with the sub-verb carried into
  the message for every removed group (`agents add`, `cron list`,
  `workflow run`, `gateway status`, ...).
- 18 removed-flag invocations on their surviving parents (`steer --takeover`;
  the 13 `up` flags including `--max-concurrency 4`; `migrate --to postgres`;
  `init example --global`; global `--backend postgres` and `--backend pglite`):
  exit 1. The two `--backend` rows fail with rc-contract section 2's exact
  `unsupported_database` sentence; every other flag fails with the removal
  sentence.
- `--backend sqlite ls`: accepted as a no-op, exit 0.
- Surviving aliases `workflow list` and `ls`: exit 0, so the removals did not
  take the live alias surface with them.

The section 5 rows are covered inside that set: `hijack` and `pause` (5.2
rows one and two), `steer --takeover` (hijack enforcement), every time-travel
verb (`replay`, `rewind`, `fork`, `timetravel`, `snapshots`, `restore`,
`snapshot-hook`, `revert`, `timeline`, `diff`), the checkpoint and worktree
verbs (`worktrees list|prune`, `tree`, `graph`), and the supervision surface
(`supervise`, `supervisor`, `top`, the `up --force`/`--steal-ownership`/
`--resume-*` flags). The MCP half of section 5's enforcement (the 10
unsupported tools answering the `unsupported` envelope, `ask_human` included)
is pinned by `test/McpServer.test.ts` inside the passing suite, including a
real stdio round trip.

## 3. Literal `corepack pnpm exec smithers` transcripts

Run from the clean checkout root. Every invocation agreed with the sweep.

```
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

$ corepack pnpm exec smithers up system/test --max-concurrency 4
smithers up --max-concurrency was removed in 1.0.0-rc.0: parallelism is declared by the flow and bounded by plan admission. See https://smithers.sh/migration/1.0#plan-admission
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

$ SMITHERS_BACKEND=pglite corepack pnpm exec smithers ls
unsupported_database: 1.0.0-rc.0 supports local SQLite only. PostgreSQL and PGlite are not available. Unset SMITHERS_BACKEND or set it to sqlite. See https://smithers.sh/migration/1.0#databases
exit=1

$ corepack pnpm exec smithers definitely-not-a-verb
[help text, then:]
ERROR
  Unknown subcommand "definitely-not-a-verb" for "smithers"
exit=2
```

The `definitely-not-a-verb` control proves removed verbs are a deliberate
exit-1 refusal, not the parser's exit-2 usage error, and its help output lists
exactly the 26 section 4.1 subcommands (plus the built-in `--completions`)
with no removed verb advertised.

Environment-variable gates:

```
$ SMITHERS_POSTGRES_URL=postgres://x SMITHERS_TEST_PG_URL=postgres://y corepack pnpm exec smithers ls
stderr:
ignored: SMITHERS_POSTGRES_URL has no effect in 1.0.0-rc.0 (SQLite only)
ignored: SMITHERS_TEST_PG_URL has no effect in 1.0.0-rc.0 (SQLite only)
exit=0 (the ls result itself is unchanged)
```

## 4. Checkout integrity

`git status --porcelain` in the clean checkout is empty after all runs. The
only state the runs touched is the git-ignored `.flows/` engine directory
(control.db, engine.db, WAL and cache files), which is engine-owned run state,
not a source edit. No fix was applied in the clean checkout.

## Appendix: full sweep results

One line per invocation: verdict, label, exit code, invocation, first output
line. Produced by
`/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/negative-sweep.sh`
(case table: `cases.tsv` in the same directory).

```
ok	alias: ls	exit=0	smithers ls	{
ok	alias: workflow list	exit=0	smithers workflow list	{
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
SWEEP-DONE 122 ok / 122 total
```
