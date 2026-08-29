# diagnostics/

Preflight diagnostics for CLI agents: three check ids (`cli_installed`,
`api_key_valid`, `rate_limit_status`) run per agent via provider-specific
strategies.

Entry points:

- `launchDiagnostics.js` — one-call wrapper used by BaseCliAgent/PiAgent;
  swallows failures to `null`.
- `getDiagnosticStrategy.js` — the strategy registry (claude, codex,
  antigravity/agy, amp, plus pi, which dispatches to whichever provider its
  model/`--provider` hint implies).
- `runDiagnostics.js` — runs a strategy's checks concurrently with a 5s
  per-check timeout.
- `enrichReportWithErrorAnalysis.js` — post-hoc rate-limit detection from an
  agent error.
- `formatDiagnosticSummary.js` — one-line human summary.

`diagnosticApiKeyEnv` (in `getDiagnosticStrategy.js`) maps pi's `--api-key`
option onto the env var the selected provider's checks read (#284); the codex
checks honor `CODEX_HOME`/auth.json subscription auth (#448).

Gotcha: probes hit real provider endpoints with short `AbortSignal` timeouts;
keep every check non-throwing (return status `"error"` instead).
