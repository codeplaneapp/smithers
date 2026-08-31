# Phase 7 gate: cli-e2e

Verdict: PASS

Every result below was taken in `migration/clean-checkout-4` at
`341c8fa87e2dadbe80d0f0d3258dae112a7d03d3` (`v1/rc0-migration`) on 2026-08-31,
09:18 to 09:28 PT. This file supersedes the run at `cd14388ed7`; that run's
file is kept beside this one as `cli-e2e-prev-cd14388ed7.md` with its logs in
`cli-e2e-logs-prev-cd14388ed7/`. Everything in the prior file that this re-run
did not re-measure still applies at the new commit; the sections below name
what changed.

## Scope

PLAN.md Phase 7 requires "CLI end-to-end tests using the working-tree CLI".
The gate adds the negative gates: every unsupported or removed command in
`docs/migration/rc-contract.md` sections 4 and 5 must refuse with exit 1 and
the migration sentence, never a usage error and never a silent success. This
re-run also validates the two wave 7/8 CLI lanes that triggered it:
`cli-refuse-before-boot` (`a506d60231`: a removed verb refuses before the
control plane boots, so a refusal creates no files) and
`init-scaffold-launch` (`13c077343b` and `363346c94e`: `init` scaffolds a
`model:` line resolved from the credentials doctor's keys, and a launch the
executor cannot take settles `failed` instead of leaving an accepted row with
owner pid 0).

Six layers of evidence, all against real `.flows/control.db` and
`.flows/engine.db` SQLite files, no mocks:

1. The complete `@smthrs/cli` test suite (36 files, 717 tests: 716 passed,
   1 skipped by design).
2. A direct sweep of 127 negative and control invocations of
   `corepack pnpm exec smithers` from the checkout root: the full section 4.2
   verb and flag tables, the section 2 database gates, the surviving aliases,
   and the usage-error control.
3. A literal stdio round trip against `corepack pnpm exec smithers --mcp`.
4. New in this run: three removed verbs (`ui`, `gateway status`,
   `workflow run`) executed from an empty temporary directory, asserting the
   exit code, the exact sentence with its anchor, and that the directory is
   still empty afterwards, through both bin entries.
5. Literal transcripts of surviving verbs: `--version`, `ls --json`, and
   `--help` from the checkout root, plus a full `init`/`ls`/`up -d`/`ps`/
   `cancel`/`down`/`status` lifecycle in a throwaway project, with the SQLite
   rows read back by a separate Node process.
6. `node scripts/check-local-smithers.mjs`, the guard that internal scripts
   execute the working tree and not a published copy.

The crash/restart fault suites under `e2e/faults` belong to the "real SQLite
persistence and crash/restart suites" gate, not this one.

## Environment

| Item | Value |
| --- | --- |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4` |
| HEAD | `341c8fa87e2dadbe80d0f0d3258dae112a7d03d3` (`v1/rc0-migration`; `git status --porcelain` empty before and after) |
| Node | v24.18.0 (engines floor `>=22.19.0`) |
| pnpm | 11.21.0 via corepack 0.35.0 (`packageManager: pnpm@11.21.0`) |
| Bun | 1.4.0 (not used by this gate; the bin shim pins Node) |
| vitest | 4.1.9, v8 coverage enabled by `packages/cli/vitest.config.ts` |
| Date | 2026-08-31 09:18 to 09:28 PT |
| Host load | 1-minute load average 3.4 at start, 11 to 44 during the window (other Phase 7 gate agents ran concurrently in this and sibling checkouts), 11.3 at the end. Under the 40 spawn-bound ceiling at every launch. |
| `SMITHERS_HOME` | unset for every invocation (`env -u SMITHERS_HOME`) |
| Disk | 12 GiB free before and after; the only scratch this run created was removed |

Dependencies were installed by the clean-install gate. One environment fact is
new since the prior evidence and matters to how the CLI was executed:
`packages/cli/dist/` appeared in this shared checkout at 09:22:25 PT, built at
this same commit by a concurrent Phase 7 gate agent (the checkout is shared;
several `packages/*/dist` directories carry the same timestamps, the pack
gates build them, and all are git-ignored). `packages/cli/bin/smithers.mjs`
prefers `dist/esm/bin.js` when it exists, so invocations before 09:22:25 ran
`src/bin.ts` through Node type stripping and invocations after ran the built
entry; both are this commit's working tree. The negative sweep straddled the
appearance and passed 127/127; the new empty-directory gate was run through
both entries with byte-identical sentences (section 4). `node
scripts/check-local-smithers.mjs` passes with the dist present.

## Delta since the superseded evidence at `cd14388ed7`

Fifteen commits landed; the `packages/cli` diff is `README.md`,
`docs/llms-full.txt`, `src/Init.ts` (+100: `defaultSeat`, `template`, the
seat note), `src/Unsupported.ts` (+51: `Unsupported.refusal`), `src/bin.ts`
(+9: the pre-boot refusal check), and four test files (+490 lines). The
removal tables in `src/Unsupported.ts` are otherwise unchanged, so the
127-case sweep needed no new cases. The suite grew from 626 to 717 tests
(`Bin.test.ts` empty-directory refusal and settle-failed cases,
`Init.test.ts` seat scaffolding, `Unsupported.test.ts` refusal-scan cases,
`EndToEnd.test.ts` scaffold-launch coverage, plus one live test that skips
without a funded seat).

## 1. Full @smthrs/cli test suite: 36 files, 716 passed, 1 skipped, exit 0

Command, run once from `packages/cli` in the clean checkout:

```
cd packages/cli && env -u SMITHERS_HOME corepack pnpm exec vitest run
```

Result (09:18:44 to 09:22:01 PT, load 11.49 at start, 29.59 at end):

```
 RUN  v4.1.9 .../migration/clean-checkout-4/packages/cli
      Coverage enabled with v8
 Test Files  36 passed (36)
      Tests  716 passed | 1 skipped (717)
   Start at  09:18:46
   Duration  194.86s (transform 34.72s, setup 0ms, import 80.45s, tests 349.09s, environment 3ms)
Statements   : 81.89% ( 1687/2060 )
Branches     : 78.87% ( 1012/1283 )
Functions    : 76.66% ( 414/540 )
Lines        : 82.22% ( 1494/1817 )
EXIT=0
```

The coverage ratchet in `packages/cli/vitest.config.ts` passed. The one
skipped test is `Bin.test.ts` "the smithers init scaffold on a funded seat",
which is `describe.skipIf(!chatgptSeat)`: it runs a real three-to-four-minute
agent run and takes itself only where `SMITHERS_OPENAI_AUTH=chatgpt` is
exported over a signed-in codex credential store. This host does not export
that seat, so the skip is the test's documented design, not a gap: the
scaffold-to-launch path it covers is exercised without a provider by the
settle-failed cases and by section 5 below. The wall-clock assertions at
`Bin.test.ts:114`/`:138` passed at this load. Full log:
`cli-e2e-logs/cli-vitest-run1.log`.

## 2. Negative-gate sweep: 127 invocations, 127 ok

The same sweep as the superseded run (`cli-e2e-logs/negative-sweep.mjs`, every
invocation `corepack pnpm exec smithers ...` from the clean checkout root,
eight at a time), 09:22:17 to 09:23:49 PT. Result:
`SWEEP-DONE PASS=127 FAIL=0 TOTAL=127`, exit 0. Full per-case table:
`cli-e2e-logs/negative-sweep.tsv`; the superseded file's appendix lists the
same 127 lines and every line reproduced byte-identically except load-order.

- 101 removed-verb invocations: exit 1 and the exact
  `smithers <verb> was removed in 1.0.0-rc.0: <reason>. See
  https://smithers.sh/migration/1.0#<anchor>` sentence, sub-verb carried into
  the message for every removed group.
- 18 removed-flag invocations on their surviving parents: exit 1; the two
  `--backend` rows and `migrate --to` fail with section 2's
  `unsupported_database` sentence.
- `--backend sqlite ls` no-op exit 0; aliases `ls` and `workflow list` exit 0;
  `definitely-not-a-verb` exits 2 with `Unknown subcommand` (the control that
  a removal is a deliberate refusal, not the parser's usage error); the four
  environment gates (`SMITHERS_BACKEND` three ways, ignored PG URLs) behave
  per section 2.

Section 4.2 and section 5 row coverage is identical to the superseded
evidence (the removal tables did not change); see its "Section 4.2 coverage"
and "Section 5 coverage" paragraphs, which stand at this commit.

One measured improvement: the sweep took 92 seconds against 377 in the
superseded run at comparable-or-lower load, because `Unsupported.refusal` now
answers a removed verb before `NodeControl.layer` boots, so the eight
concurrent refusals no longer contend on the checkout root's two SQLite
files. That is the `cli-refuse-before-boot` lane observed at the process
boundary.

## 3. MCP stdio round trip: 21 tools, 10 unsupported envelopes

`env -u SMITHERS_HOME node cli-e2e-logs/mcp-probe.mjs <checkout>` (09:23:55 to
09:24:05 PT). Exit 0, `MCP-PROBE-DONE unsupported=10 bad=0`.

```
initialize -> {"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"smithers","version":"1.0.0-rc.0"}}
tools/list -> 21 tools: list_workflows, run_workflow, list_runs, get_run, watch_run, get_run_events, explain_run, list_pending_approvals, resolve_approval, get_node_detail, get_chat_transcript, revert_attempt, fork_run, replay_run, rewind_run, restore_checkpoint, list_snapshots, get_timeline, time_travel, list_artifacts, ask_human
```

The 11 supported and 10 unsupported tools and every envelope match section
4.1 and the superseded evidence exactly. Full output:
`cli-e2e-logs/mcp-probe.log`.

## 4. Removed verbs from an empty directory create nothing

New in this run; the acceptance for `cli-refuse-before-boot`. Each verb ran
from a freshly created empty temporary directory, and `find . | wc -l`
printed `1` (the directory itself, nothing else) after the refusal. Run twice:
once through `packages/cli/bin/smithers.mjs` (which resolved to the built
`dist/esm/bin.js`, 09:24:58 PT, `cli-e2e-logs/empty-dir-refusals.txt`) and
once directly through `src/bin.ts` (09:26:20 PT,
`cli-e2e-logs/empty-dir-refusals-src-entry.txt`). Both entries printed
byte-identical sentences:

```
$ smithers ui
smithers ui was removed in 1.0.0-rc.0: replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted. See https://smithers.sh/migration/1.0#ui
exit=1
$ find . | wc -l
1

$ smithers gateway status
smithers gateway status was removed in 1.0.0-rc.0: replaced by `smithers serve` and the Electrobun product UI; the terminal monitor is deleted. See https://smithers.sh/migration/1.0#gateway
exit=1
$ find . | wc -l
1

$ smithers workflow run
smithers workflow run was removed in 1.0.0-rc.0: JSX pack tooling is gone; `smithers migrate` replaces `upgrade`. See https://smithers.sh/migration/1.0#workflow
exit=1
$ find . | wc -l
1
```

Before `a506d60231` each of these booted `NodeControl.layer` on the way to
the sentence and left `<cwd>/.flows/` with both databases behind; now the
refusal is a sentence and exit 1 with no filesystem side effect.

## 5. Surviving verbs still boot the control plane

### 5a. From the clean checkout root

`cli-e2e-logs/surviving-verbs.txt` (09:25:24 PT):

```
$ corepack pnpm exec smithers --version
smithers v1.0.0-rc.0
exit=0

$ corepack pnpm exec smithers ls --json
{"_tag":"flows","items":[... 10 descriptors: create-flow/{clarify,design,document,fix,provision,scaffold}, create-skill/{clarify,design,document,scaffold} ...]}
exit=0
```

`corepack pnpm exec smithers --help` (exit 0, `cli-e2e-logs/cli-help.txt`)
lists exactly the 26 section 4.1 subcommands and advertises no removed verb.

### 5b. Full lifecycle in a throwaway project: init, ls, up -d, ps, cancel, down

`cli-e2e-logs/temp-project-lifecycle.txt` (09:26:55 to 09:28 PT). A temporary
git repository outside the checkout, with the environment scrubbed of
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `OPENROUTER_API_KEY`, and the
`Bin.test.ts` unservable-seat fixture staged: `SMITHERS_OPENAI_AUTH=chatgpt`
routes the openai seat to a codex credential store whose `auth.json` is `{}`,
so the seat resolves, the launch is accepted, and the first turn fails
locally reading the token. No network, no provider spend, and a real
`control.run.failed` settlement.

```
$ smithers init hello --json
{"created":true,"flowFile":".../flows/hello/flow.mdx","gitignore":"created","name":"hello","seat":"openai:gpt-5.6-sol","stateDirectory":".../.flows"}
exit=0
```

The scaffolded frontmatter carries the `init-scaffold-launch` behavior: a
`model: openai:gpt-5.6-sol` line with the comment naming
`SMITHERS_OPENAI_AUTH` as the credential that chose it, exactly
`Init.defaultSeat`'s doctor-ordered resolution.

```
$ smithers ls --json
{"_tag":"flows","items":[{"description":"A starter Smithers flow.","flowId":"hello"}]}
exit=0

$ smithers up hello -d --json
{"detached":true,"logFile":".../.flows/logs/run-1.log","runId":"run-1"}
exit=0

$ smithers ps --json
{"_tag":"runs","items":[{...,"flowId":"hello","planId":"plan-1","runId":"run-1","status":"failed",...}]}
exit=0

$ smithers cancel run-1 --json
{"_tag":"Terminal","runId":"run-1","status":"failed"}
exit=0

$ smithers down
{ "cancelled": [] }
exit=0

$ smithers status run-1
Verdict   failed — /harness/HarnessError: The cell frame failed
Run       run-1 · hello · openai:gpt-5.6-sol · 0s
Activity  1 turns · 0 calls (0 refused, 0 duplicate) · edits 0/0
exit=0
```

The detached launch printed one JSON document on stdout and exited 0 after
the admission line; the run settled `failed` within 306 ms; the cancel
against the terminal run returned the `Terminal` receipt and wrote no event
(section 5.1 "Cancel"); `down` found nothing non-terminal. SQLite rows read
back by a separate read-only `node:sqlite` process:

```
engine.db flows_runs: [{"run_id":"run-1","status":"failed","finished":1,"owner_pid":null}]
engine.db flows_journal_events by type: control.agent.discipline-armed 1, control.agent.turn-opened 1,
  control.approval.approved 1, control.plan.created 1, control.run.accepted 1, control.run.failed 1,
  control.run.running 1, flows.engine.attempt-finished 1, flows.engine.attempt-started 1,
  flows.engine.run-decision 3, flows.engine.snapshot-identified 1
control.db flows_journal_events: 0 rows (see section 7)
```

`owner_pid` is null on the settled row: the `363346c94e` fix observed at the
boundary; the superseded run at `cd14388ed7` predates it and this shape is
what `Init.ts`'s docstring records the old behavior against ("accepted but
the executor did not take it"). The project directory was deleted after the
readings.

## 6. Working-tree guard and checkout integrity

```
$ node scripts/check-local-smithers.mjs
check-local-smithers: internal scripts run the Smithers working tree
exit=0
```

`git status --porcelain` in the clean checkout is empty after all runs. The
state at the checkout root is git-ignored: `.flows/` (cache from earlier
gates; `control.db` and `engine.db` refreshed by this run's `ls`/`ps`
invocations) and the `packages/*/dist` trees a concurrent gate built. No fix
was applied in the clean checkout; the empty directories and the throwaway
project under this session's scratchpad were removed.

## 7. Follow-ups for a fix lane (advisory, not blockers)

- Carried forward from the superseded evidence, still present at this commit:
  `packages/cli/test/Bin.test.ts:1208` `turnsOpened` counts
  `control.agent.turn-opened` rows in `.flows/control.db`, but under the CLI
  composition every journal row is written to `.flows/engine.db` (the table
  listing in section 5b), so the helper compares 0 with 0. Point it at
  `engine.db` and assert `turns` is 1 after the first launch.
- New observation: a genuine usage error still boots the control plane. An
  unknown single token (measured with the literal argument `"gateway status"`
  passed as one word, exit 2, `Unknown subcommand`) creates `<cwd>/.flows/`
  with both databases before the parser answers. `Unsupported.refusal` is
  deliberately narrow and this shape is outside the removed-verb contract,
  but an operator typo now leaves a state directory a removed verb no longer
  does. Ownership: `packages/cli/src/bin.ts` config ordering.

## Raw logs

`cli-e2e-logs/` beside this file: `cli-vitest-run1.log`,
`negative-sweep.mjs`, `negative-sweep.log`, `negative-sweep.tsv`,
`mcp-probe.mjs`, `mcp-probe.log`, `empty-dir-refusals.txt`,
`empty-dir-refusals-src-entry.txt`, `surviving-verbs.txt`, `cli-help.txt`,
`temp-project-lifecycle.txt`. The superseded run is
`cli-e2e-prev-cd14388ed7.md` with `cli-e2e-logs-prev-cd14388ed7/`; its
appendix's 127-line sweep table is reproduced verbatim by this run's
`negative-sweep.tsv`.
