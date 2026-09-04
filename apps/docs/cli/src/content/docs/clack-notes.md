---
title: "Clack Notes"
description: "Node command-line interface for Smithers control"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/docs/clack-notes.md"
---

Research notes for `src/Ui.ts`, the rendering layer that wraps clack. Facts
below were read from the installed packages under
`node_modules/.pnpm/@clack+prompts@1.7.0` and `@clack+core@1.4.3`, the
upstream README and CHANGELOG at `bombshell-dev/clack`, and a disposable
prototype driven with fake streams (2026-09-03).

## Versions, packaging, size

| Package | Version | Format | Node | dist size | Runtime deps |
| --- | --- | --- | --- | --- | --- |
| `@clack/prompts` | 1.7.0 | ESM only (`dist/index.mjs`, `.d.mts`) | `>= 20.12.0` | 84 KB | `@clack/core@1.4.3`, `sisteransi`, `fast-string-width`, `fast-wrap-ansi` |
| `@clack/core` | 1.4.3 | ESM only | `>= 20.12.0` | 52 KB | `sisteransi` |

- 1.0.0 dropped the CJS build. Our `dist/cjs` build bundles with esbuild, so
  an ESM-only dependency is loadable there through a dynamic import only.
  `Ui.ts` is imported by `Command.ts` which the CJS entry reaches, so the CJS
  build must externalize `@clack/prompts` or the CJS consumer must be on a Node
  that supports `require(esm)` (22.12+, which our `>=22.19.0` engine floor
  guarantees).
- 1.1.0 replaced `picocolors` with Node's `util.styleText`. Colour is decided
  by `styleText`'s default stream check against **`process.stdout`**, not the
  `output` option: a fake `Writable` gets colour when the real stdout is a
  TTY and none when it is piped or `NO_COLOR` is set. Tests strip escapes with
  `util.stripVTControlCharacters` instead of asserting on colour.
- Store status: both packages were already in the pnpm store as transitive
  dependencies of `alchemy@2.0.0-beta.72`. No workspace package imported clack.
  `@clack/prompts@1.7.0` is now a direct dependency of `@smthrs/cli`
  (`packages/smithers/package.json`), installed with
  `timeout 600 pnpm install --offline --filter @smthrs/cli`.

## API surface (1.7.0)

Every function accepts `CommonOptions { input?, output?, signal?, withGuide? }`
unless noted. `output` defaults to `process.stdout`.

| Export | Behaviour |
| --- | --- |
| `intro(title)` | Writes `┌  title`. |
| `outro(message)` | Writes `│`, `└  message`, blank line. |
| `cancel(message)` | Writes `└  message` in red. Does not exit. |
| `note(message, title, { format })` | Boxed multi-line block, wrapped to `getColumns(output) - 6`. |
| `box(message, title, opts)` | Standalone box: `contentAlign`, `titleAlign`, `width`, `rounded`, `formatBorder`. Present since 1.0.0. |
| `log.message / info / success / step / warn / warning / error` | One guide line then `symbol  text`; multi-line strings continue with `│  `. `spacing` controls the leading blank guide lines. |
| `spinner({ indicator: "dots" \| "timer", onCancel, cancelMessage, errorMessage, frames, delay, styleFrame, signal })` | `start(msg)`, `message(msg)`, `stop(msg)` (green `◇`), `cancel(msg)` (red `■`), `error(msg)` (red `▲`), `clear()` (erase frame, no final line), `isCancelled`. Registers `SIGINT`, `SIGTERM`, `exit`, `unhandledRejection`, `uncaughtExceptionMonitor` listeners while running and removes them on stop. Under `CI=true` it prints one line per message change instead of animating. The frame is repainted with cursor moves regardless of TTY, so a piped stdout receives escape sequences. |
| `progress({ style, max, size, ...spinner })` | Spinner plus `advance(step, msg)` bar. |
| `text / password / multiline / confirm / select / multiselect / groupMultiselect / autocomplete / autocompleteMultiselect / selectKey / date / path` | Modal prompts. Each resolves to the value or the cancel symbol. `validate` accepts a function or a Standard Schema. `select` and friends take `maxItems` and `showInstructions`. |
| `group({ a: () => text(...), b: ({ results }) => ... }, { onCancel })` | Sequential prompts sharing results; `onCancel` receives partial results. |
| `tasks([{ title, task(message), enabled }])` | One spinner per task, sequentially. |
| `taskLog({ title, limit, retainLog })` | Scrolling subprocess log that clears on `success()` and stays on `error()`; only animates when `!isCI() && isTTY(output)`. |
| `stream.message / info / success / step / warn / error(iterable)` | Prints an `Iterable<string> \| AsyncIterable<string>` as ONE log entry, chunk by chunk, wrapping at `process.stdout.columns`. **Hard-codes `process.stdout`**: no `output` option, so it is untestable with a fake sink and unusable for a per-item list. |
| `limitOptions`, `formatInstructionFooter`, `symbol(state)`, `symbolBar(state)` | Building blocks for custom prompts. |
| `isCancel(value)` | `value === Symbol("clack:cancel")` (re-exported from core). |
| `settings`, `updateSettings({ aliases, messages: { cancel, error }, withGuide, date })` | Process-global. Default aliases `k/j/h/l`, `escape`, `\x03`. |
| `isTTY(output)`, `isCI()`, `unicode`, `unicodeOr(a, b)` | `isCI` is `process.env.CI === "true"`. `unicode` is true except on the Linux kernel console, and on Windows only under WT, VS Code, xterm-256color, alacritty, Terminus, JediTerm. |

### Symbols

`S_STEP_ACTIVE ◆`, `S_STEP_SUBMIT ◇`, `S_STEP_CANCEL ■`, `S_STEP_ERROR ▲`,
`S_BAR_START ┌`, `S_BAR │`, `S_BAR_END └`, `S_RADIO_ACTIVE ●`,
`S_RADIO_INACTIVE ○`, `S_CHECKBOX_* ◻/◼`, `S_INFO ●` (blue),
`S_SUCCESS ◆` (green), `S_WARN ▲` (yellow), `S_ERROR ■` (red), `S_BAR_H ─`,
box corners `╭ ╮ ╰ ╯`, `S_CONNECT_LEFT ├`. ASCII fallbacks when
`unicode` is false: `* o x T | — > [ ] [+] • ! -`.

### Colours

`symbol(state)`: `initial`/`active` cyan `◆`, `cancel` red `■`, `error` yellow
`▲`, `submit` green `◇`. Guide bars are gray, active prompt bars cyan, error
bars yellow. Hints and inactive options are `dim`; disabled options are gray
strikethrough.

## Cancellation

- Prompts run `input` in raw mode, so Ctrl+C arrives as the `\x03` keypress,
  not as `SIGINT`. The prompt resolves to the cancel symbol; `isCancel()` is
  the only way to tell. The process does not exit: the caller decides
  (`sv` prints `cancel("Exiting.")` and exits 0).
- `bin.ts` maps a real `SIGINT` to exit 130. That path is untouched by a
  cancelled prompt, so a verb that wants 130 after a cancelled prompt has to
  set it. During a spinner, `SIGINT` is delivered as a signal: the spinner
  prints its cancel line and calls `onCancel`, and `bin.ts` still sees the
  signal because listeners are additive.
- `signal: AbortSignal` cancels a prompt or spinner from code.

## Non-TTY behaviour

clack itself does not degrade. A prompt on a piped stdin waits on readline
until the stream ends; a spinner on a piped stdout writes cursor sequences.
`isTTY(output)` and `isCI()` are exported so the caller can branch. The
ecosystem does the same: `create-nuxt` and `sv` assume a terminal and offer
flags to skip questions. `Ui.ts` therefore owns the decision: `interactive`
is `stdout.isTTY && stdin.isTTY && CI !== "true" && TERM !== "dumb"`, and every
method has a plain-line fallback.

## Ecosystem

- `@clack/core` exposes `Prompt` plus `SelectPrompt`, `TextPrompt`,
  `ConfirmPrompt`, `AutocompletePrompt`, and so on. A custom prompt is
  `new Prompt({ render() { ... }, input, output })` with `this.state`,
  `this.value`, `this.on("cursor" | "key" | "value" | "submit" | "cancel")`.
  The private `render` runs on keypress and on `output`'s `resize` event, so
  external updates need an emitted `resize` or a subclass. `block()`,
  `getColumns()`, `getRows()`, `wrapTextWithPrefix()` are the layout helpers.
- `sv` (sveltejs/cli, `packages/sv/src/cli/create.ts`): `intro`, `group` of
  `text`/`select`/`confirm`, `log.warn`/`log.success`, `note("What's next?")`,
  `isCancel` then `cancel("Exiting.")` and `process.exit(0)`. Spinner and logs
  interleave by stopping the spinner before a log and starting a new one after.
- `create-nuxt` (nuxt/cli, `@clack/prompts ^1.7.0`): `intro`, `select` for
  package manager and template, `confirm` for git init, `spinner` around
  `giget`, `cancel` on `isCancel`, and CLI flags that answer each prompt so CI
  never blocks.
- `create-astro` uses Astro's own `@astrojs/cli-kit` (a clack-era fork with
  Houston), not clack; it branches on `stdout.columns < 80` for narrow and CI
  terminals.
- `consola` v3 prompts are built on `@clack/core`.

## Design decision: stream into the log, select at the end

Two candidate patterns for "pick a suggestion while the scan is still
running":

1. **Log then select.** Suggestions print as they arrive, each a `◇` step
   line, with a spinner underneath that says the scan continues. When the
   iterable settles (or the caller aborts it), one `select` over the collected
   items opens.
2. **Live select.** A `@clack/core` custom prompt whose option list grows as
   items arrive, re-rendered by emitting `resize` on the output stream.

`Ui.streamSuggestions` + `Ui.pickSuggestion` implement pattern 1, because:

- Prompts are modal. A `select` owns stdin in raw mode and repaints by
  erasing its previous frame with `process.stdout.columns`. Any line written
  between two frames (a new suggestion, a warning from the scan) corrupts the
  frame. Pattern 2 needs every scan output to go through the prompt's own
  render, which couples the scan to the prompt.
- Moving options move the cursor. An operator who is on item 3 when item 2's
  neighbour arrives reads a different list than the one they navigated.
  Scrollback lines never move.
- The spinner already makes "scan is continuing" visible, and the arrival
  order is preserved in scrollback for the `--json` and piped renderings,
  which print exactly the same lines without a spinner.
- Early pick is still possible: the scan takes an `AbortSignal`; a Ctrl+C
  during the scan (the caller's handler aborts the signal) settles the stream
  with the items received so far and the select opens over those.

The spinner/log interleave is `spinner.clear()`, `log.step(line)`,
`spinner.start(message)` per item, the same handshake `sv` uses with
`stop()`/`start()`, minus the completion line `stop()` would print.

`clack.stream.*` was rejected for the item list: it renders one log entry
whose chunks are joined on one line, and it writes to `process.stdout` with
no `output` option, so no test can observe it.

## Gotchas met while prototyping

- `spinner().clear()` unregisters the process listeners and unblocks stdin;
  `start()` again re-registers both. Do not call `message()` expecting a
  redraw before the next tick (80 ms, 120 ms without unicode).
- `note()` and `box()` measure `getColumns(output)`, which falls back to 80
  when the sink has no `columns`. Give a fake sink `columns` for stable
  wrapping.
- A fake `Readable` drives prompts: write `"\x1b[B"` for down, `"\r"` for
  enter, `"\x03"` for cancel, after the prompt has attached its keypress
  listener (next tick).
- `styleText` decides colour from `process.stdout`, so a test that pins bytes
  must strip VT sequences or run with `NO_COLOR=1`.
