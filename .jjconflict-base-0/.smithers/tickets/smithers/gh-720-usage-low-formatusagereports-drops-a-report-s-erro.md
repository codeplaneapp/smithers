# 🐛 usage: [low] formatUsageReports drops a report's error when it also has windows (429 rate-limit notice never shown)

GitHub: https://github.com/smithersai/smithers/issues/720

_via ultracode (Opus multi-agent) review_

`formatUsageReports` renders `r.error` only when a report has zero windows; a report carrying both windows and an error loses the error.

**Where**
- `packages/usage/src/formatUsageReports.js:46` — `const note = r.error ?? ...` is inside the `if (r.windows.length === 0)` branch (line 45).
- `packages/usage/src/formatUsageReports.js:50-53` — the non-empty path iterates `r.windows` and never references `r.error`.

**Failure scenario**
On HTTP 429, `anthropicHeaderUsage.js` / `openaiHeaderUsage.js` return `{ source: "headers", windows, error: "Rate limited (429) — retry after Ns" }`; the 429 response still carries the rate-limit header family, so `windows` is non-empty (see the parsed windows in `parseAnthropicRateLimitHeaders.js`). `buildUsageReport.js` copies `probe.error` into the report. `formatUsageReports` then prints the window rows and silently discards the "Rate limited (429)" text. Confirmed reachable by `packages/usage/tests/usage-coverage.test.js:56-76`, where a 429 yields both `usage.windows[0]` and `usage.error`.

**Why it matters**
The one moment an operator most needs the error — they just got throttled — is exactly when the table hides it, because the throttled response also carried windows. The `error` field's documented purpose ("reason when source is none OR a probe failed", `UsageReport.ts`) is defeated for any report holding both windows and an error.

**Fix sketch**
Surface `r.error` even when windows exist — e.g. append a note row (or a trailing marker column) after the window rows whenever `r.error` is set.
