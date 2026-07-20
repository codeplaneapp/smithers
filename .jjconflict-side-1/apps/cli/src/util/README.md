# apps/cli/src/util

Small CLI-wide utilities.

- `exitCodes.js` (+ `CliExitCode.ts` sidecar) — the uniform exit codes for the
  devtools live-run commands: 0 ok / 1 user error / 2 server error /
  3 declined / 130 sigint.
- `errorMessage.js` (+ `CliErrorMapping.ts` sidecar) — maps stable error codes
  to message/hint/exitCode (`CLI_ERROR_MESSAGES`, `getCliErrorMapping`) and
  holds `formatCliErrorForStderr` plus its inverse `parseCliErrorFromStderr`.
  The formatter and parser must stay in lockstep — the `--format json` path
  re-parses captured stderr text.
- `envDetect.js` — `isCI` / `isAgentHarness` for interactive-vs-structured
  decisions. `isAgentHarness` must be read at process start: Claude Code strips
  `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` from child-process env.
- `logger.ts` — the Effect logger for the CLI (`SmithersLoggerLayer`, compact
  colorized line format, `SMITHERS_LOG_LEVEL` threshold) plus JSON-mode console
  routing that redirects all `console.*` to stderr when `--json` output must
  own stdout.

Gotcha: `logger.ts` calls `installJsonModeConsoleRouting()` at import time
(module side effect), and JSON-mode state lives on a `Symbol.for` global so
multiple module instances share one state.
