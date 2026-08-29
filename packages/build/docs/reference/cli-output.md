# Terminal output

What `smthrs` prints while it runs, how it decides between a live display, a
coloured log, and bare lines, and where each stream goes.

Every command still returns structured data on standard output through
[incur](https://github.com/wevm/incur). This page is about the human side:
progress on standard error, and the tree or table a person sees instead of
the envelope.

## Renderers

| Renderer | What it does                                                                                                                                                                  | When `auto` picks it                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `tty`    | Draws in place. Running targets spin at the bottom of the screen with their elapsed time; settled targets scroll above them in completion order; a footer closes the run.     | Standard output and standard error are both terminals.                                               |
| `stream` | The same glyphs, colours, and aligned columns, one line per event, never moving the cursor. Safe in any log that accepts colour.                                              | Standard error is a terminal but standard output is not, or `FORCE_COLOR` is set under a pipe or CI. |
| `plain`  | Exactly the lines the executor has always printed: `label  status  duration` per settled target and `N targets: a hit, b ran, c failed, d skipped (t)` at the end. No colour. | Anything else: a pipe, `CI`, `NO_COLOR`, `TERM=dumb`, or an explicit `--format`.                     |

`--ui <auto|tty|stream|plain>` is a global option on every command and wins
over everything. `SMTHRS_UI` in the environment is the default for `--ui`,
in the manner of Turborepo's `TURBO_UI` and Nx's `NX_TUI`.

The full order `auto` applies:

1. `SMTHRS_UI`, when it names a renderer.
2. `--format` or `--json` given: `plain`. A program is reading.
3. `NO_COLOR` non-empty, or `TERM=dumb`: `plain`.
4. `CI` non-empty: `stream` when `FORCE_COLOR` asks for colour, else `plain`.
5. Two terminals: `tty`.
6. A terminal on standard error, or `FORCE_COLOR` under a pipe: `stream`.
7. Otherwise `plain`.

Colour follows [no-color.org](https://no-color.org) and
[force-color.org](https://force-color.org): `NO_COLOR` set to anything but
the empty string wins, then `FORCE_COLOR` (`0` and `false` refuse, any other
value forces), then `TERM=dumb` refuses, then the stream must be a terminal.
An explicit `--ui tty` under `NO_COLOR` draws live without colour.

## Streams and exit codes

Progress always goes to standard error. With `--format json` on a terminal,
`auto` picks `plain`, so the envelope on standard output is never interleaved
with a spinner; with `--ui tty --format json` the live display still runs on
standard error and the JSON still arrives clean on standard output.

When a human renderer is active and incur agrees standard output belongs to a
person, an execution command prints nothing on standard output: the display
already said everything the envelope would. A red run ends with one red line,
`✗ 2 of 6 targets failed: //src:a, //src:b`, and exit code 1; incur's
`Error (targets_failed): …` block is not printed, because the same fact is
already on the screen. Under a pipe, `--ui plain`, or an explicit format the
envelope and the structured `code`, `message`, `retryable` error are exactly
what they were.

`query` renders a listing as `LABEL`, `TARGET`, `KINDS` columns and
`deps(label)` as the root over its closure; `graph` renders the tree with dim
box-drawing, a bold root, cyan rule names, and dim file groups. Both write to
standard output, because they are the command's answer rather than progress,
and both return the structured data instead whenever a program is reading.
`graph --mermaid` is always the envelope.

## Anatomy of a run

```
▸ //:all  5 targets · 16 jobs
✗ //:lintCheck    failed      20ms
    command failed (exit 1): /bin/sh -c echo 'src/App.tsx:12:5 error: unused variable foo' >&2; exit 1
    src/App.tsx:12:5 error: unused variable foo
    src/Nav.tsx:4:1 warning: missing return type
✗ //:smoke        failed       0ms
    refused: gate //:lintCheck is not green (gates: //:lintCheck=failed)
✓ //:unit                     1.1s
✓ //:integration              2.0s
✗ //:all          failed       0ms
    suite is red; members: //:unit=ran, //:integration=ran, //:lintCheck=failed, //:smoke=failed

Tasks: 2 ran, 3 failed, 5 total · Time: 2.1s
✗ 3 of 5 targets failed: //:all, //:smoke, //:lintCheck
```

| Element                              | Meaning                                                                                                                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `▸ verb pattern  N targets · J jobs` | The header, once per run. The bare-label form shows the label alone.                                                                                                                                                                         |
| `✓` green                            | Ran green.                                                                                                                                                                                                                                   |
| `○` dim, `cached`                    | Answered from the result cache.                                                                                                                                                                                                              |
| `✗` red, `failed`                    | Executed and failed, or refused. The first line under it is the failure message. Lines the producer indented, such as an agent lint's findings, are a `•` list; a tool's own output tail is shown as the tool wrote it.                      |
| `↷` yellow, `skipped`                | Never ran because a dependency did not succeed.                                                                                                                                                                                              |
| Right-aligned duration               | Milliseconds below one second, tenths of a second above, in one column for every line.                                                                                                                                                       |
| Dim `label  message` lines           | The executor's progress notes: cache misses, service readiness, agent rounds, closure sizes.                                                                                                                                                 |
| `⚠` yellow                           | A run-level warning, such as a cache store the executor could not write.                                                                                                                                                                     |
| `Tasks: … · Time: …`                 | The footer. Zero counts are omitted; `total` is always present. When every target was a cache hit the line ends `>>> FULL CACHE`.                                                                                                            |
| `⠋ label  elapsed`                   | `tty` only. One pinned line per running target, at most eleven, then `… N more running`, then `done/total · running · elapsed`. The pinned lines are cut to the terminal width so the redraw arithmetic holds; scrolled lines are never cut. |

Under `stream` a dim `▸ label` line marks each start, so a hung target is
visible in a CI log.

## Contract for executors

`packages/build-cli/src/Reporter.ts` is the seam. An executor receives a
`Reporter` and reports events; it never formats a line.

| Event                                     | Reported when                                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `begin({ verb, pattern, jobs, targets })` | Once, before scheduling, so the renderer can size its label column.                                                                                                            |
| `targetStarted(label)`                    | A target enters the scheduler and is not blocked by a failed dependency.                                                                                                       |
| `targetFinished(report)`                  | A target settles as `hit`, `ran`, `failed`, or `skipped`.                                                                                                                      |
| `note(line)`                              | A free-form progress line: `label  message` or `smthrs: message`.                                                                                                              |
| `warn(line)`                              | A run-level warning.                                                                                                                                                           |
| `toolOutput(label, stream, chunk)`        | A child's output chunk. No executor streams a child today: `ExecLive` captures both pipes and folds their tails into the failure message. The hook is there for when one does. |
| `summary(summary)`                        | Once, with the final counts.                                                                                                                                                   |
| `close()`                                 | Always, in a `finally`, so a live renderer hands the terminal back.                                                                                                            |

`Reporter.of({ reporter, log })` keeps the older `log` sink working: without a
reporter it builds the `plain` renderer over `log`, and without either it
writes plain lines to standard error. That is what keeps `Executor.execute`
and `PackageExec.run` byte-identical for every caller that passes `log`.

## Prior art

| Tool      | Mode selection                                                                                                                                                            | Live display                                                                                                                                                                            | Cache hit                                                                                                | Footer                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turborepo | `ui: "tui" \| "stream"` in `turbo.json`, `--ui`, `TURBO_UI`; colour from `FORCE_COLOR` and whether stdout is a terminal, no `NO_COLOR`                                    | Ratatui task table beside a real terminal pane; `✓` green, `⊙` magenta italic for cache hits, `⨯` red; a static `»` spinner                                                             | `cache hit, replaying logs {hash}`, `cache hit (outputs already on disk), suppressing logs`              | `Tasks:    N successful, M total`, `Cached:    X cached, M total`, `Time:    Ys >>> FULL TURBO`, `Failed:    ids`                                                                  |
| Nx        | `--output-style` (`tui`, `dynamic`, `static`, `static-failures-only`, `stream`), `NX_TUI`, `tui.enabled`; TUI requires stderr TTY, unicode, a size, and no CI or AI agent | Task list with `✔` `✖` `⏭` `◼` `·` and a braille throbber at 80 ms; dynamic renderer pins `→  Executing 3/7 remaining tasks…`, `✔  2/3 succeeded [1 read from cache]`, `✖  1/3 failed`  | `✔  nx run app:build  [local cache]`, `[remote cache]`, `[existing outputs match the cache, left as is]` | `Successfully ran target build for 3 projects (2s)` and `Nx read the output from the cache instead of running the command for N out of M tasks.`                                   |
| Bazel     | `--curses=auto`, `--color=auto`, both resolved by the client's `--isatty`; `TERM` `dumb`, `emacs`, `xterm-mono` refuse                                                    | A progress bar pinned at the bottom, cleared with cursor-up and erase-line, redrawn at `--show_progress_rate_limit` (0.2 s), floored to 1 s without cursor control; events scroll above | `[N / M] Executing genrule …` counters rather than per-target lines                                      | `INFO: Elapsed time: 3.212s, Critical Path: 1.10s`, `INFO: N processes: …`, `INFO: Build completed successfully, N total actions` or `FAILED: Build did NOT complete successfully` |
| Buck2     | `--console auto\|simple\|simplenotty\|simpletty\|super\|none`, `BUCK_CONSOLE`; superconsole when stderr is a TTY                                                          | superconsole: a canvas at the bottom re-rendered each tick, emitted lines above it never touched again                                                                                  |                                                                                                          |                                                                                                                                                                                    |
| pnpm      | `--reporter default\|append-only\|ndjson\|silent`; `append-only` when `CI` or stdout is not a TTY                                                                         | `ansi-diff` over the bottom frame, `\x1b[0J` after every update, 200 ms throttle on a TTY and 1 s in append-only mode                                                                   |                                                                                                          |                                                                                                                                                                                    |

Sources: Turborepo [run](https://turborepo.dev/docs/reference/run),
[configuration](https://turborepo.dev/docs/reference/configuration),
[system environment variables](https://turborepo.dev/docs/reference/system-environment-variables),
[`crates/turborepo-run-summary/src/execution.rs`](https://github.com/vercel/turborepo/blob/main/crates/turborepo-run-summary/src/execution.rs),
[`crates/turborepo-run-cache/src/lib.rs`](https://github.com/vercel/turborepo/blob/main/crates/turborepo-run-cache/src/lib.rs),
[`crates/turborepo-ui/src/color_selector.rs`](https://github.com/vercel/turborepo/blob/main/crates/turborepo-ui/src/color_selector.rs),
[`crates/turborepo-ui/src/tui/table.rs`](https://github.com/vercel/turborepo/blob/main/crates/turborepo-ui/src/tui/table.rs),
[`crates/turborepo-ui/src/lib.rs`](https://github.com/vercel/turborepo/blob/main/crates/turborepo-ui/src/lib.rs).
Nx [nx.json](https://nx.dev/reference/nx-json),
[terminal UI](https://nx.dev/docs/kb/terminal-ui),
[run-many](https://nx.dev/reference/core-api/nx/documents/run-many),
[`is-tui-enabled.ts`](https://github.com/nrwl/nx/blob/master/packages/nx/src/tasks-runner/is-tui-enabled.ts),
[`run-command.ts`](https://github.com/nrwl/nx/blob/master/packages/nx/src/tasks-runner/run-command.ts),
[`dynamic-run-many-terminal-output-life-cycle.ts`](https://github.com/nrwl/nx/blob/master/packages/nx/src/tasks-runner/life-cycles/dynamic-run-many-terminal-output-life-cycle.ts),
[`utils/output.ts`](https://github.com/nrwl/nx/blob/master/packages/nx/src/utils/output.ts),
[`native/tui/status_icons.rs`](https://github.com/nrwl/nx/blob/master/packages/nx/src/native/tui/status_icons.rs).
Bazel [command-line reference](https://bazel.build/reference/command-line-reference),
[user manual](https://bazel.build/docs/user-manual),
[`UiOptions.java`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/runtime/UiOptions.java),
[`UiEventHandler.java`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/runtime/UiEventHandler.java),
[`UiStateTracker.java`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/runtime/UiStateTracker.java),
[`BuildSummaryStatsModule.java`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/runtime/BuildSummaryStatsModule.java),
[`BuildResultPrinter.java`](https://github.com/bazelbuild/bazel/blob/master/src/main/java/com/google/devtools/build/lib/buildtool/BuildResultPrinter.java).
Buck2 [interactive console](https://buck2.build/docs/users/build_observability/interactive_console/),
[common options](https://buck2.build/docs/users/commands/common-options/),
[`superconsole.rs`](https://github.com/facebookincubator/superconsole/blob/main/src/superconsole.rs).
pnpm [install](https://pnpm.io/cli/install), [CLI settings](https://pnpm.io/settings/cli),
[`pnpm/src/main.ts`](https://github.com/pnpm/pnpm/blob/main/pnpm11/pnpm/src/main.ts),
[`default-reporter/src/index.ts`](https://github.com/pnpm/pnpm/blob/main/pnpm11/cli/default-reporter/src/index.ts).
Conventions [no-color.org](https://no-color.org), [force-color.org](https://force-color.org),
[`supports-color/index.js`](https://github.com/chalk/supports-color/blob/main/index.js).

What this design takes from each:

| From      | Taken                                                                                                                                                                                                                                                   | Left out, and why                                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Turborepo | The `ui` config and env override shape (`--ui`, `SMTHRS_UI`); the `Tasks: … Time: …` footer and the `>>> FULL TURBO` celebration as `>>> FULL CACHE`; the `Failed:` list on one line; the five-colour per-label prefix palette for `toolOutput`         | The `tui` with panes and keybindings: nothing streams a child yet, so there is nothing to put in a pane. `--log-order grouped` and `--output-logs` wait on the same producer.                     |
| Nx        | The `✔` `✖` glyph vocabulary, the braille `dots` spinner at 80 ms, pinned `done/total` progress, the "read from cache" count folded into the footer, `CI` and `--format` as hard reasons to stay static, picocolors-class raw escapes over a dependency | The `NX` inverse-video badge and full-width em-dash separators: they spend rows a bounded build display does not need. GitHub Actions `::group::` folding: a follow-up once child output streams. |
| Bazel     | Cursor-up plus erase-to-end-of-screen redraw of a bottom region; the region is cut to the terminal width so the line count is exact; `--curses=auto` becoming a TTY check; one final status line rather than a scrolling INFO stream                    | `--show_progress_rate_limit`, `--progress_in_terminal_title`, `--show_result`: no user has asked for them.                                                                                        |
| Buck2     | The canvas-and-emit model: emitted lines above the canvas are written once and never revisited, only the canvas is redrawn                                                                                                                              | `--console` sub-panels.                                                                                                                                                                           |
| pnpm      | `append-only` as the precise meaning of `stream`, no cursor manipulation ever; `\x1b[0J` after every frame so anything a child printed below the frame is cleared                                                                                       | `ndjson`: incur's `--format jsonl` already covers a machine consumer.                                                                                                                             |

## Before and after

Taken from [artsy/force](https://github.com/artsy/force), a PACKAGE.ts
workspace, on a red `biome lint`. `--ui plain` is what every version printed
before this page existed; the `tty` sample is ANSI-stripped and the spinner
frames are omitted.

`smthrs //src:lint --ui plain`, piped:

```
//src:srcs  ran  3ms
//src:lint  failed  1.9s  command failed (exit 1): /usr/bin/sandbox-exec -p (version 1)(allow default)(deny network*)(allow network* (local unix-socket)) /Users/williamcory/artsy/force/node_modules/.bin/biome lint --no-errors-on-unmatched
of consistent names through a code base.

  i Use a named export instead.

/Users/williamcory/artsy/force/__mocks__/@loadable/component.tsx:4:3 lint/style/useConst  FIXABLE  ━━━━━━━━━━
…
2 targets: 0 hit, 1 ran, 1 failed, 0 skipped (1.9s)
code: targets_failed
message: 1 of 2 targets failed
retryable: false
```

`smthrs //src:lint --ui tty` on a terminal:

```
▸ //src:lint  2 targets · 16 jobs
✓ //src:srcs               3ms
✗ //src:lint  failed      1.4s
    command failed (exit 1): /usr/bin/sandbox-exec -p (version 1)(allow default)(deny network*)(allow network* (local unix-socket)) /Users/williamcory/artsy/force/node_modules/.bin/biome lint --no-errors-on-unmatched
    of consistent names through a code base.
      • i Use a named export instead.
    /Users/williamcory/artsy/force/__mocks__/@loadable/component.tsx:4:3 lint/style/useConst  FIXABLE  ━━━━━━━━━━
    …

Tasks: 1 ran, 1 failed, 2 total · Time: 1.9s
✗ 1 of 2 targets failed: //src:lint
```

`smthrs //src/Server:test --ui tty`, second run, answered from the cache:

```
▸ //src/Server:test  3 targets · 16 jobs
✓ //src/Server:srcs                                    1ms
  //src/Server:__private_ImportClosure_1  closure: 3061 files, 91 packages, 0 unresolved, 0 dynamic
✓ //src/Server:__private_ImportClosure_1               0ms
○ //src/Server:test                       cached       0ms

Tasks: 2 ran, 1 cached, 3 total · Time: 4ms
```

`smthrs query '//...' --ui tty` on a terminal:

```
LABEL                                           TARGET                  KINDS
//.github:ci                                    Github.Workflow         run lint
//.github:danger                                Shell.Run               run
//.storybook:storybookBuild                     Shell.Build             build
//:detectSecrets                                Shell.Test              test
//data:schema                                   Filegroup
```

`smthrs graph '//src:build' --ui tty` on a terminal:

```
//src:build
  -data-> //src:buildClient
  -data-> //src:buildServer
```

The same commands under a pipe, with `--format json`, or with `--ui plain`
print the envelope they always did.

## Not done

Child output does not stream, so `toolOutput` has no producer and there is no
grouped or prefixed log mode; the failure tail is the whole of a tool's
voice. There is no interactive pane, no keybindings, no terminal title, and
no GitHub Actions log folding. Package-mode `graph` has never had a Mermaid
renderer; `--mermaid` there still returns the text graph in the envelope.
