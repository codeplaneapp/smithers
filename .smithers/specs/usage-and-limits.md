# Usage & Limits: reporting consumed quota across every provider

**Status:** v1 implemented (CLI). Gateway RPC + studio dashboard + Google estimate deferred.
**Author:** generated with Claude Code
**Date:** 2026-06-03
**Scope:** A `smithers usage` surface that reports, per registered account, how much
of each provider's rate limit or subscription quota has been consumed, with a CLI
command, a gateway RPC, and a studio dashboard.

## Implementation status

Shipped in `packages/usage` + the `smithers usage` CLI command:

- Engine: `getAccountUsage` dispatcher, `getUsageForAccounts` (parallel + cached),
  the normalized `UsageReport`/`UsageWindow` model, and the on-disk usage cache
  with per-provider polling floors (180s hard floor for `claude-code`).
- Real adapters: `claude-code` (oauth usage endpoint), `codex` (wham/usage),
  `anthropic-api` and `openai-api` (live rate-limit headers). Credential readers for
  Claude (`.credentials.json` + macOS Keychain) and Codex (`auth.json` + JWT claim).
- CLI: `smithers usage [--account] [--provider] [--fresh]`, human table to stderr,
  structured envelope (`--format json`) to stdout, matching `smithers agents list`.
- Tests: `packages/usage/tests/usage.test.js` (parsers, formatter, cache, dispatcher).

Deferred (phases 4–6 below): Google local-estimate accounting (`gemini`,
`antigravity`, `gemini-api` currently report `source: "none"` honestly), the
`getUsage`/`listUsage` gateway RPC, and the studio Usage dashboard.

---

## 1. What we are building

Today smithers can detect that a provider is rate limited, but only as a side effect
of a failed run. `packages/agents/src/diagnostics/getDiagnosticStrategy.js` probes each
provider on failure and every subscription path returns `skip`:

```js
// claudeRateLimitCheck, when ANTHROPIC_API_KEY is absent:
status: "skip",
message: "Subscription mode — cannot probe rate limits via API",
```

That `skip` is the whole gap. Most smithers users run subscription auth (Claude Max,
ChatGPT/Codex, Google login), which is exactly the path that reports nothing. We want a
first-class answer to "how much of my limit have I used, and when does it reset" for
every account in `~/.smithers/accounts.json`, covering both subscription and API-key
modes.

The deliverable is three surfaces over one shared engine:

1. `smithers usage` — CLI command, table or `--json`, optional `--watch`.
2. `getUsage` / `listUsage` gateway RPC — so the UI and remote callers can read it.
3. A studio **Usage** dashboard — per-account meters with reset countdowns.

---

## 2. The core finding: there is no single "usage" surface

Research across the three provider families produced one load-bearing conclusion: the
data exists in three incompatible shapes, and the feature has to normalize them rather
than assume a common API.

| Shape | Who exposes it | What you get |
| --- | --- | --- |
| **Subscription utilization** | Claude Code OAuth, Codex ChatGPT | percent-used + reset time for a rolling 5h window and a weekly window |
| **Live API-key headers** | Anthropic API, OpenAI API | remaining/limit/reset for per-minute request and token buckets |
| **Nothing live** | Google (Gemini/Antigravity/Pi) | only a 429 `RetryInfo` after you hit the wall; remaining quota is not exposed to a personal-login client |

So the normalized model must express percent-used **and** remaining-count **and**
"unknown, estimated locally" without pretending they are the same thing. Section 5
defines that model.

A second finding worth stating up front: for the subscription providers there is **no
officially documented endpoint**. The real numbers come from undocumented endpoints that
the official CLIs themselves call, reachable only by reading the CLI's own OAuth token off
disk. Those endpoints are authoritative (they power the in-CLI `/usage` and `/status`
views) but unstable. The design treats them as a best-effort source with a documented
fallback, never as a contract.

---

## 3. Per-provider capability matrix

This is the heart of the spec. Each row is one account provider from
`packages/accounts/src/AccountProvider.ts`. "Source" is what the adapter calls;
"Auth" is where the adapter reads credentials from.

### 3.1 `claude-code` (Claude Max/Pro subscription)

- **Source:** `GET https://api.anthropic.com/api/oauth/usage` (undocumented; powers `/usage`).
- **Auth:** Bearer OAuth access token. On Linux/Windows read `<configDir>/.credentials.json`;
  on macOS read the Keychain item `Claude Code-credentials`
  (`security find-generic-password -s "Claude Code-credentials" -w`). The account's
  `configDir` is the per-account `CLAUDE_CONFIG_DIR` (see `accountToProviderEnv.js`).
  Token JSON shape:
  ```json
  { "claudeAiOauth": { "accessToken": "sk-ant-oat01-…", "refreshToken": "sk-ant-ort01-…",
                       "expiresAt": 1748276587173, "scopes": ["user:inference","user:profile"] } }
  ```
- **Required headers:** `Authorization: Bearer <accessToken>`,
  `anthropic-beta: oauth-2025-04-20`, `User-Agent: claude-code/<version>`,
  `Content-Type: application/json`. The `User-Agent` is load-bearing: without it the
  endpoint drops you into an aggressively rate-limited bucket that returns persistent 429s.
- **Response:**
  ```json
  { "five_hour":  { "utilization": 33.0, "resets_at": "2026-04-11T07:00:00Z" },
    "seven_day":  { "utilization": 13.0, "resets_at": "2026-04-17T00:59:59Z" },
    "seven_day_opus": null, "seven_day_sonnet": null }
  ```
- **Windows produced:** `5h` and `weekly` (plus per-model weekly when non-null), unit = percent.
- **Polling floor:** no more than once per 180s per account.

### 3.2 `anthropic-api` (API key)

- **Source:** live response headers off any Messages call. For a standalone probe reuse the
  existing `POST /v1/messages/count_tokens` call (already in `claudeRateLimitCheck`); it
  returns the rate-limit header family without generating output tokens.
- **Auth:** `ANTHROPIC_API_KEY` from the account `apiKey`.
- **Headers parsed:** `anthropic-ratelimit-requests-{limit,remaining,reset}`,
  `anthropic-ratelimit-tokens-{limit,remaining,reset}` (unified), and the
  `input-tokens` / `output-tokens` variants. On 429, `retry-after` (seconds).
- **Windows produced:** `requests-per-min`, `tokens-per-min` (and input/output split),
  unit = count, with `limit`, `remaining`, `resetsAt`.
- **Historical totals (optional):** the Admin Usage/Cost API
  (`GET /v1/organizations/usage_report/messages`, `/v1/organizations/cost_report`) needs
  an `sk-ant-admin…` key, which individual accounts do not have. Out of scope for v1;
  noted as an enrichment path for org accounts.

### 3.3 `codex` (ChatGPT subscription)

- **Source:** `GET https://chatgpt.com/backend-api/wham/usage` (undocumented; same data the
  Codex `/status` view shows, confirmed against the `openai/codex` Rust source). No turn is
  spent.
- **Auth:** Bearer access token from `<configDir>/auth.json` (the per-account `CODEX_HOME`).
  Shape:
  ```json
  { "OPENAI_API_KEY": null, "auth_mode": "chatgpt",
    "tokens": { "access_token": "…", "refresh_token": "…", "id_token": "<JWT>", "account_id": "…" },
    "last_refresh": "2026-06-01T12:00:00Z" }
  ```
  The `id_token` JWT carries `chatgpt_account_id` and `chatgpt_plan_type`.
- **Required headers:** `Authorization: Bearer <access_token>`,
  `ChatGPT-Account-Id: <chatgpt_account_id>`, `User-Agent: codex-cli`.
- **Response (normalized from the same struct the CLI uses):**
  ```json
  { "primary":   { "used_percent": 12.5, "window_minutes": 300,   "reset_at": 1717420000 },
    "secondary": { "used_percent": 40.0, "window_minutes": 10080, "reset_at": 1717500000 },
    "credits":   { "has_credits": true, "unlimited": false, "balance": "12.34" },
    "plan_type": "pro" }
  ```
  `primary` (window_minutes ≈ 300) is the 5h window; `secondary` (≈ 10080) is weekly.
- **Windows produced:** `5h`, `weekly`, unit = percent, plus an optional `credits` field.
- **Zero-credentials fallback:** spawn `codex -s read-only -a untrusted app-server` and call
  the JSON-RPC method `account/rateLimits/read`, which returns the same snapshot without us
  touching the token file. Use this when the token is expired and we choose not to refresh it.

### 3.4 `openai-api` (API key)

- **Source:** live response headers. `GET /v1/models` does **not** return them; a tiny
  `POST /v1/chat/completions` with `max_tokens: 1` does. The existing diagnostics call
  `GET /v1/models` and therefore only ever sees "no headers returned" — the usage adapter
  must use the cheap POST instead.
- **Auth:** `OPENAI_API_KEY` from the account `apiKey`.
- **Headers parsed:** `x-ratelimit-{limit,remaining,reset}-requests`,
  `x-ratelimit-{limit,remaining,reset}-tokens`. The `*-reset-*` values are Go-duration
  strings (`"6m0s"`), parse to seconds.
- **Windows produced:** `requests-per-min`, `tokens-per-min`, unit = count.
- **Historical (optional):** `GET /v1/organization/usage/completions` and
  `/v1/organization/costs` need an admin key. Out of scope for v1.

### 3.5 `gemini`, `antigravity`, `pi`, `gemini-api` (Google)

The honest row. There is **no live remaining-quota surface** for a personal Google login or
a Gemini API key. Confirmed: Google returns no `x-ratelimit-*` headers; on exhaustion you
get `429 RESOURCE_EXHAUSTED` with a `google.rpc.RetryInfo.retryDelay` in the body.

- **Tier label (weak):** `POST https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`
  returns `currentTier`/`paidTier`. This tells you *which* published cap applies, not how
  much is left. Reverse-engineered and unstable.
- **Published caps (the only ground truth):** hard-coded per tier. Code Assist free =
  60 RPM / 1,000 req-day; AI Pro = 1,500/day; AI Ultra = 2,000/day; Gemini API free =
  250/day.
- **What v1 ships for Google:** local token-log accounting (Section 7) plus the 429
  `retryDelay` as a live "currently blocked" signal. The window unit is `estimated`, and
  the report is explicitly labeled as a local estimate, not server truth.
- **Deprecation note:** Google has announced Gemini Code Assist for individuals / AI Pro /
  AI Ultra in Gemini CLI stops serving on **2026-06-18**, steering users to Antigravity.
  Build the Google adapter so the cap table and the `loadCodeAssist` tier probe are data,
  not branching logic, because the numbers will move.
- **Auth on disk:** Gemini CLI OAuth at `<configDir>/oauth_creds.json` (`access_token`,
  `refresh_token`, `expiry_date`, `id_token`). Antigravity stores in the system keyring with
  an encrypted `<configDir>/antigravity-cli/credentials.enc` fallback. Pi uses API-key only at
  `~/.pi/agent/auth.json`.

### 3.6 `kimi` and the CLI-managed agents (amp, opencode, forge)

- **Kimi:** OAuth subscription with tokens at `<configDir>/credentials/*.json`. No known usage
  endpoint yet. v1 reports `source: "none"` with a clear "not supported" reason; revisit if
  Kimi exposes a usage surface.
- **amp / opencode / forge:** own auth, no exposed usage surface. Report `source: "none"`.

### 3.7 Summary

| Provider | Auth mode | Source | Live data? | Unit |
| --- | --- | --- | --- | --- |
| claude-code | subscription | `/api/oauth/usage` | yes (5h + weekly %) | percent |
| anthropic-api | api key | response headers | yes (rpm + tpm) | count |
| codex | subscription | `/backend-api/wham/usage` | yes (5h + weekly %) | percent |
| openai-api | api key | response headers (POST) | yes (rpm + tpm) | count |
| gemini / pi / gemini-api | login or key | local logs + 429 | estimate only | estimated |
| antigravity | subscription | local logs + 429 | estimate only | estimated |
| kimi | subscription | none | no | — |
| amp / opencode / forge | own | none | no | — |

---

## 4. Architecture

One engine, three surfaces. The engine lives in a new domain package and follows the same
dispatch shape as the existing `accountToProviderEnv` and `getDiagnosticStrategy`.

```
accounts.json ──► getAccountUsage(account) ──► UsageReport
                        │
        ┌───────────────┼───────────────┬───────────────┐
   claudeOauthUsage  codexWhamUsage  *RateLimitHeaders  googleLocalUsage
        │               │               │                 │
   reads configDir   reads configDir  uses apiKey       reads run logs
   credentials       credentials                         + cap table
```

### 4.1 New package: `packages/usage`

Per the repo conventions (one export per file, filename matches the export, `index.ts` is a
barrel only, colocate by domain), the layout is:

```
packages/usage/src/
  UsageReport.ts            # the normalized result type
  UsageWindow.ts            # one limit window (5h, weekly, rpm, …)
  UsageSource.ts            # union: "oauth" | "headers" | "local" | "none"
  getAccountUsage.js        # dispatcher: Account -> Promise<UsageReport>
  claudeOauthUsage.js       # claude-code subscription adapter
  anthropicHeaderUsage.js   # anthropic-api adapter
  codexWhamUsage.js         # codex subscription adapter
  openaiHeaderUsage.js      # openai-api adapter
  googleLocalUsage.js       # gemini/antigravity/pi/gemini-api estimate
  readClaudeCredentials.js  # configDir/keychain -> oauth token
  readCodexCredentials.js   # configDir/auth.json -> access token + account id
  readGeminiCredentials.js  # configDir/oauth_creds.json
  publishedCaps.js          # Google cap table, keyed by tier
  usageCache.js             # TTL cache with per-provider polling floor
  index.ts                  # barrel
```

`getAccountUsage` is a switch on `account.provider`, mirroring `accountToProviderEnv` so the
two stay structurally identical and easy to keep in sync.

### 4.2 Refactor the diagnostics rate-limit check onto this engine

`getDiagnosticStrategy.js` already does half of this for API-key mode (Anthropic
count_tokens, OpenAI models, Google models). Move that header-parsing logic into
`anthropicHeaderUsage.js` / `openaiHeaderUsage.js` and have the diagnostic check call the
shared adapter, so there is one source of truth for "remaining tokens." The diagnostic stays
failure-time; the usage feature is on-demand. They share the parser, not the trigger.

### 4.3 Credentials stay on the host that owns them

The adapters read OAuth tokens from disk or Keychain. That read happens on the machine where
the CLI is authenticated. The gateway RPC therefore runs `getAccountUsage` **locally** and
returns only the normalized `UsageReport`. Tokens are never serialized into an RPC payload,
never logged, never sent to studio. Section 9 covers this.

---

## 5. Normalized data model

```ts
// UsageWindow.ts
export type UsageWindow = {
  id: string;            // "5h" | "weekly" | "requests-per-min" | "tokens-per-min" | "daily"
  label: string;         // human label, e.g. "5-hour session"
  unit: "percent" | "count" | "estimated";
  usedPercent?: number;  // 0–100, set for percent + estimated
  used?: number;         // absolute, set for count + estimated
  limit?: number;        // absolute cap, set for count + estimated
  remaining?: number;    // limit - used, set for count
  resetsAt?: string;     // ISO-8601; when this window rolls over
};

// UsageReport.ts
export type UsageReport = {
  accountLabel: string;
  provider: AccountProvider;
  authMode: "subscription" | "api-key";
  source: "oauth" | "headers" | "local" | "none";
  windows: UsageWindow[];
  planType?: string;     // "pro", "max", tier name
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
  fetchedAt: string;     // ISO-8601
  stale: boolean;        // served from cache past its soft TTL
  estimate: boolean;     // true for Google local accounting
  error?: string;        // populated when source === "none" or a probe failed
};
```

This model expresses all three shapes. A Claude report has two `percent` windows; an
OpenAI-API report has two `count` windows with `remaining`; a Gemini report has one
`estimated` window with `estimate: true`; a Kimi report has empty `windows` and an `error`.

---

## 6. CLI command: `smithers usage`

Registered in `apps/cli/src/index.js` alongside the existing `agent` commands, using the
same Incur `.command()` + `listAccounts()` pattern.

```
smithers usage                     # all accounts, table
smithers usage --account claude-work
smithers usage --provider codex
smithers usage --json              # machine-readable UsageReport[]
smithers usage --watch             # refresh on the per-provider polling floor
```

Table output:

```
ACCOUNT       PROVIDER      PLAN   WINDOW        USED       RESETS IN
claude-work   claude-code   max    5-hour        33%        2h 41m
claude-work   claude-code   max    weekly        13%        5d 3h
codex-main    codex         pro    5-hour        12%        4h 02m
codex-main    codex         pro    weekly        40%        6d 1h
openai-ci     openai-api    —      requests/min   820/1000   00:42
openai-ci     openai-api    —      tokens/min     impacted   00:42
gemini-free   gemini        free   daily (est.)  ~310/1000   18h 12m   ⚠ estimate
kimi-main     kimi          —      —              not supported
```

`--watch` reuses `usageCache.js`; it never polls a single account faster than its floor
(180s for Claude OAuth, ~60s for header probes, local recompute for Google).

---

## 7. Local token-log accounting (the Google fallback)

For providers with no live surface, estimate consumption from what smithers already records.
Every CLI agent already extracts `usage` from its output
(`BaseCliAgent.extractUsageFromOutput` → `buildGenerateResult`), so request and token counts
per run already flow through the orchestrator. The Google adapter:

1. Identifies the active account/tier (env key, `loadCodeAssist` tier probe, or account config).
2. Sums requests issued since the window start (daily rollover in the account's timezone) from
   the run event history.
3. Subtracts from the published cap in `publishedCaps.js`.
4. Returns a `UsageWindow` with `unit: "estimated"`, `estimate: true`, and a `⚠ estimate` label.

This is explicitly a lower bound: it counts requests smithers made, not requests the same
Google account made from other tools sharing the quota. The UI must never present an estimate
as authoritative. When a 429 `RetryInfo` is seen on a live run, surface its `retryDelay` as a
hard "blocked until" overlay on the estimate.

---

## 8. Gateway RPC and studio dashboard

### 8.1 Gateway

Add to the gateway RPC contract:

- `getUsage({ accountLabel })` → `UsageReport`
- `listUsage()` → `UsageReport[]` (all registered accounts)

Both run `getAccountUsage` host-side and return normalized reports only. Add a `usage:read`
scope to the gateway scope set. Results are served through `usageCache.js` so multiple UI
clients share one upstream poll.

### 8.2 Studio dashboard

studio-2 already has a dashboard overlay system
(`apps/smithers-studio-2/src/chat/overlay/dashboard/`) with stat tiles, status rows, and
tables, plus a `ViewsMenu`. Add:

- `mockUsageDashboard.ts` for the design/mock pass (the existing dashboards are all mocked).
- A real `usage` dashboard wired to `listUsage` once the gateway RPC lands, registered in
  `dashboards.ts` and surfaced in `ViewsMenu`.

Each account renders as a card: plan badge, one meter per window (percent fill or
remaining/limit), and a live reset countdown. Estimated windows get a distinct treatment and
an "estimate" tag so they never read as authoritative.

Per the repo's no-mocks rule, the studio **e2e** for this drives a real gateway against a
seeded account, not `page.route`. The `mock*Dashboard.ts` file is only the static design
fixture, consistent with the other dashboards in that directory.

---

## 9. Security and safety

- **Token handling.** Adapters read OAuth tokens (Keychain or `0600` files) only to mint the
  outbound `Authorization` header. Tokens are never logged, never written elsewhere, never
  placed in an RPC payload. The macOS Keychain read may prompt; treat a denied prompt as
  `source: "none"` with a clear message, not an error.
- **Refresh.** If a Claude/Codex access token is expired, prefer letting the official CLI
  refresh it (read after the CLI has run) over implementing refresh ourselves. The Codex
  app-server fallback (`account/rateLimits/read`) avoids touching the token entirely and is
  the safer path when the token is stale.
- **Polling floors are mandatory.** The Claude OAuth usage endpoint 429s aggressively; never
  poll below 180s/account. Header probes cost a request (and, for OpenAI, one token), so cache
  them too. `usageCache.js` enforces this centrally.
- **Undocumented endpoints are best-effort.** `/api/oauth/usage` and `/backend-api/wham/usage`
  are reverse-engineered and have broken before. Every adapter degrades to `source: "none"`
  with a readable reason rather than throwing, so one provider's outage never breaks the
  command.
- **Correct `User-Agent`.** Send `claude-code/<version>` and `codex-cli`. These are required
  for the endpoints to behave, and they keep us honestly identifiable rather than spoofing a
  browser.

---

## 10. Phased implementation

Docs-driven, per repo convention: this spec lands first, then the API doc for `smithers usage`,
then code.

1. **Engine + Anthropic.** `packages/usage` scaffold, `UsageReport`/`UsageWindow`,
   `getAccountUsage` dispatcher, `claudeOauthUsage` + `anthropicHeaderUsage`,
   `readClaudeCredentials` (incl. macOS Keychain), `usageCache`. Unit tests against recorded
   fixtures.
2. **CLI command.** `smithers usage` table + `--json` + `--account`/`--provider` filters over
   the two Anthropic adapters. This is the first shippable slice.
3. **Codex + OpenAI.** `codexWhamUsage` (with the app-server fallback), `openaiHeaderUsage`
   (cheap POST), `readCodexCredentials`. Refactor the diagnostics header parsing onto the
   shared adapters.
4. **Google estimate.** `googleLocalUsage`, `publishedCaps`, `loadCodeAssist` tier probe,
   429 `RetryInfo` surfacing. Clearly labeled estimates.
5. **Gateway + studio.** `getUsage`/`listUsage` RPC, `usage:read` scope, `mockUsageDashboard`,
   then the real dashboard and a real-backend e2e.
6. **`--watch` + polish.** Live countdowns, watch mode, and wiring `smithers agent list` to
   annotate each account with its current top window.

---

## 11. Testing

- **Unit (`bun test`).** Each adapter against recorded JSON/header fixtures: a healthy Claude
  report, an exhausted weekly window, a Codex pro snapshot, OpenAI headers including a 429
  `retry-after`, a Google 429 `RetryInfo`, a Kimi `source: "none"`. Parsing only, no network.
- **Credential reads.** `readClaudeCredentials`/`readCodexCredentials` against temp `configDir`
  fixtures (file path) and a mocked Keychain seam (no real Keychain in CI). Use a DI seam for
  the spawn/read, not module mocks (per the known `bun mock.module()` leak).
- **CLI.** Snapshot the table and `--json` output for a seeded multi-account `accounts.json`.
- **Studio e2e (`playwright`, real backend).** Boot the real gateway with a seeded account,
  open the Usage dashboard, assert the meter and reset countdown render from `listUsage`.
  No route mocking.
- **No live-network tests in CI.** The undocumented endpoints are exercised by a manual,
  opt-in script (`SMITHERS_USAGE_LIVE=1`) so CI never depends on a third-party undocumented
  surface.

---

## 12. Open questions

- **Kimi usage.** Does Kimi expose a usage endpoint we can read with the stored OAuth token?
  If yes, it becomes a fourth real adapter; if not, it stays `source: "none"`.
- **Anthropic Admin API for org accounts.** Worth surfacing historical spend for accounts that
  do hold an `sk-ant-admin` key, as an enrichment beyond live limits?
- **Antigravity post-deprecation.** Once Antigravity becomes Google's primary CLI, does it
  expose a usage surface better than Gemini's? Re-check after 2026-06-18.
- **Cost vs limits.** This spec reports *limits/quota consumed*. A sibling feature could report
  *cost* from the same token logs. Keep the model open to a `cost` field but do not build it in
  v1.
```
