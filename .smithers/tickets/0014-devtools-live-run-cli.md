# Add DevTools Live-Run CLI Commands

> Quality bar: spec §9. CLI additions are user-reachable; UX and error
> messaging matter as much as correctness.

## Context

Spec: `.smithers/specs/live-run-devtools-ui.md` §4.2 item 5.

The four RPCs from 0010–0013 are useful from the terminal: scripting,
debugging a live run without opening the gui, and test fixtures.

## Scope

Four subcommands in `apps/cli/src/`:

### `smithers tree <runId>`

Prints current `DevToolsSnapshot` as indented XML-like tree.

Flags:
- `--frame <frameNo>` (int ≥ 0) — historical frame.
- `--watch` — stream via `streamDevTools`, re-render on each event.
- `--json` — raw snapshot JSON.
- `--depth <n>` (int > 0) — truncate rendering depth (default unlimited).
- `--node <nodeId>` — scope to a subtree.

### `smithers diff <runId> <nodeId>`

Prints `DiffBundle` as unified diff.

Flags:
- `--iteration <n>` — default latest.
- `--json` — raw bundle.
- `--stat` — summary only.
- `--color <auto|always|never>` — default auto (isatty).

### `smithers output <runId> <nodeId>`

Prints task output row.

Flags:
- `--iteration <n>` — default latest.
- `--json` — raw row (default).
- `--pretty` — schema-ordered pretty render.

### `smithers rewind <runId> <frameNo>`

Calls `jumpToFrame`. Prompts for confirmation unless `--yes`.

Flags:
- `--yes` — skip prompt.
- `--json` — emit JumpResult as JSON.

Exit codes (uniform across all four):
- `0` — success.
- `1` — user error (missing args, invalid flag, typed Invalid* from server).
- `2` — server error / runtime error.
- `3` — rewind declined by user.
- `130` — SIGINT.

## Files (expected)

- `apps/cli/src/tree.ts` (new)
- `apps/cli/src/diff.ts` (new)
- `apps/cli/src/output.ts` (new)
- `apps/cli/src/rewind.ts` (new)
- `apps/cli/src/index.ts` (register subcommands)
- `apps/cli/src/util/exitCodes.ts` (new)
- `apps/cli/src/util/errorMessage.ts` (new — maps error codes to user-
  friendly messages with hints)
- `apps/cli/tests/tree.test.ts`, `diff.test.ts`, `output.test.ts`,
  `rewind.test.ts` (new)
- `apps/cli/tests/integration.test.ts` (new)

## Testing & Validation

### Unit tests — per command

- Help text renders.
- Every flag parsed correctly.
- Every flag validated (invalid int → user error with message).
- JSON mode emits parseable JSON (each test `JSON.parse` the stdout).
- Pretty mode matches fixture exactly.
- Error code mapping: every typed error from the server yields the
  expected exit code + user message on stderr.
- `--watch`: receives SIGINT, exits 130, unsubscribes cleanly
  (verify via server-side subscription count going to 0).

### Input-boundary tests

| Case                            | Expected                          |
|---------------------------------|-----------------------------------|
| no runId                        | exit 1, usage message             |
| runId with invalid chars        | server returns `InvalidRunId`; CLI maps to exit 1 + hint |
| frame = -1 / nonexistent        | exit 1, clear message             |
| server unreachable              | exit 2, hint: "check SMITHERS_HOST" |
| auth expired                    | exit 2, hint: "run smithers login" |
| very large diff (100 MB)        | streamed to stdout, no buffer overflow; `--stat` shows summary |
| rewind without `--yes`, stdin not tty | exit 3 (cannot prompt), hint: "rerun with --yes" |
| rewind with `--yes`, server returns `Busy` | exit 2, hint: "another rewind in progress" |
| rewind declined at prompt       | exit 3, no server mutation        |
| tree --watch, server restarts   | CLI reconnects with last seq, logs reconnect to stderr |

### Integration tests

Run against a local fixture server (real RPC layer, in-process):

- `smithers tree <runId>` on fixture run → matches snapshot.
- `smithers tree --watch` receives live events → each event re-renders
  stdout; on SIGINT exits cleanly.
- `smithers diff` on a run with a known diff → output matches fixture.
- `smithers output --pretty` renders fields in schema order.
- `smithers rewind --yes` succeeds → audit row exists, subsequent
  `tree` shows rolled-back state.

### UX tests

- Color output disabled when stdout is not a TTY (verify via piped
  redirect).
- `--color never` strips ANSI even on TTY.
- Large output paginates (or at least documents the recommended pager
  pattern: pipe to `less -R`).
- Errors go to stderr, data goes to stdout (grep-friendly).
- `--help` on each subcommand renders < 60 columns clean.

## Observability

CLI inherits the same OTel export path as the server when configured via
env (no new infra).

### Logs

- Structured to stderr when `SMITHERS_LOG_JSON=1` set.
- `info` on each command invocation: `{ cmd, runId, flags, durationMs, exitCode }`.
- `debug` on server calls.

### Metrics

- Counter: `smithers_cli_command_total{cmd,exit}`.
- Histogram: `smithers_cli_command_duration_ms{cmd}`.

## Security

- Inherits auth from existing CLI auth flow.
- No runId logging from non-authorized sessions (server-side enforced).

## Acceptance

- [ ] All unit + integration tests pass.
- [ ] Every boundary case handled with documented exit code + hint.
- [ ] JSON mode output is valid JSON (asserted).
- [ ] Watch mode cleanly unsubscribes on SIGINT.
- [ ] Color disabled in non-TTY.
- [ ] `--help` text reviewed and clean.
- [ ] Error code → user message table exhaustive (every server-side
      error code mapped).
- [ ] Exit codes match documented table.
- [ ] Logs/metrics emitted when env is set.

## Blocked by

- smithers/0010, 0011, 0012, 0013
