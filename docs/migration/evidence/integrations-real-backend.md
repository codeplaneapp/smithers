# Phase 7 gate: integrations-real-backend

Verdict: **PASS**.

GitHub and Linear, the two rc.0 real integrations (rc-contract section 3.2, `@smthrs/integrations` row; PLAN Phase 7 "exercise one real integration"), pass their real-backend contract suites against `api.github.com` and `api.linear.app` from the clean checkout. Telegram, the third adapter in the package, is **ENV-SKIP**: neither `TELEGRAM_BOT_TOKEN` nor `SMITHERS_TELEGRAM_BOT_TOKEN` is present on this host. The rc-contract and the suite header both state that Telegram is not an rc.0 release-smoke integration. The full `@smthrs/integrations` suite, fixture and live together, passes with its coverage thresholds.

## Scope

rc-contract section 3.2 (`@smthrs/integrations`, ruling A7) defines the rc.0 integration set as the GitHub, Linear, and Telegram clients rebuilt on the action, notification, and trigger APIs, with webhook ingress as library code bound to `@smthrs/control` `WebhookChannel`. It states: "GitHub and Linear are rc.0's real integrations and satisfy the Phase 7 'exercise one real integration' smoke." Every other vendor adapter moved to the plugins repository or was deleted. Section 10 (Plue cutover) names no additional integration.

Real-backend suites in the clean checkout, found by scanning for `*Live*.test.ts` and `skipIf(` on credential environment variables outside `legacy/` and `node_modules/`:

| Suite | Backend | Credential variable | Writes |
| --- | --- | --- | --- |
| `packages/integrations/test/GitHubLive.test.ts` | `https://api.github.com` | `GITHUB_TOKEN` or `SMITHERS_GITHUB_TOKEN` | none |
| `packages/integrations/test/LinearLive.test.ts` | `https://api.linear.app/graphql` | `LINEAR_API_KEY` or `SMITHERS_LINEAR_API_KEY` | none |
| `packages/integrations/test/TelegramLive.test.ts` | `https://api.telegram.org` | `TELEGRAM_BOT_TOKEN` or `SMITHERS_TELEGRAM_BOT_TOKEN` | none (`getUpdates` with no offset confirms nothing) |

Out of scope, with the reason:

- `packages/control/test/ControlLive*.test.ts`, `packages/engine-store/test/LeaseLiveness.test.ts`, `packages/platform-node/test/HostLiveness.test.ts`: engine liveness suites over local SQLite, not vendor integrations. They run in the package-test gate.
- `packages/build-cli/test/AgentSession.test.ts` (`SMTHRS_CODEX_SMOKE=1`) and `packages/harness/test/WorkerdSmoke.test.ts` (`FLOWS_WORKERD_SMOKE=1`): opt-in agent CLI and workerd smokes, not `@smthrs/integrations` adapters.
- `examples/test/12-agent-live-smoke.test.ts`: model-seat smoke, owned by the examples gate.

## Environment

| Item | Value |
| --- | --- |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-2` |
| Branch and HEAD | `v1/rc0-migration` at `20b32c6316487497301db74ec70cbe951428ef53` |
| `git status --short` | empty (clean) |
| `git submodule status` | ` 47589ada70c12b3e829b5c98ab32503abad49eac vendor/jj (v0.25.0-3759-g47589ada7)` |
| Host | macOS arm64, Darwin 25.2.0 |
| Node | `v24.18.0` |
| Bun | `1.4.0` |
| pnpm | `11.21.0` (`corepack pnpm --version` matches `packageManager: pnpm@11.21.0`) |
| vitest | `4.1.9` |
| Date | 2026-08-30 23:59 to 2026-08-31 00:01 local time |

Credential presence, checked by name only (values never printed):

| Variable | State | Source used |
| --- | --- | --- |
| `GITHUB_TOKEN` | unset in the shell | Supplied per command as `GITHUB_TOKEN="$(gh auth token)"`. `gh auth status`: logged in to github.com as `roninjin10` via keyring, scopes `gist`, `read:org`, `repo`, `workflow`. The suite is read-only. |
| `SMITHERS_GITHUB_TOKEN` | unset | not needed |
| `LINEAR_API_KEY` | set in the shell | ambient environment |
| `SMITHERS_LINEAR_API_KEY` | unset | not needed |
| `TELEGRAM_BOT_TOKEN` | unset | absent |
| `SMITHERS_TELEGRAM_BOT_TOKEN` | unset | absent |

Telegram credential search: shell environment, `~/.smithers/.env`, `~/.smithers/env`, `~/smithers/.env`, `~/smithers/.env.local`, `~/.zshrc`, `~/.zshenv`, `~/.zprofile`, `~/.config/smithers/.env` (assignment by name), and the macOS keychain (`security find-generic-password -s TELEGRAM_BOT_TOKEN`). No assignment found.

Network preflight, unauthenticated:

```
api.github.com /rate_limit (unauth) HTTP 200
api.linear.app /graphql (unauth POST) HTTP 401
api.telegram.org (no token) HTTP 404
```

## Commands and results

### 0. Frozen install

```sh
cd /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-2
corepack pnpm install --frozen-lockfile --offline
```

Final lines:

```
Scope: all 64 workspace projects
Already up to date
Done in 467ms using pnpm v11.21.0
```

Exit code: 0.

### 1. GitHub live contract (PASS)

The package's `vitest.config.ts` enables v8 coverage with thresholds by default. Running one live file alone would fail those thresholds for a reason unrelated to the backend, so isolated runs disable coverage. Command 4 below measures coverage over the whole suite.

```sh
cd /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-2/packages/integrations
GITHUB_TOKEN="$(gh auth token)" corepack pnpm exec vitest run test/GitHubLive.test.ts --coverage.enabled=false --reporter=verbose
```

Output:

```
 RUN  v4.1.9 .../clean-checkout-2/packages/integrations

 ✓ test/GitHubLive.test.ts > GitHub live contract (GITHUB_TOKEN) > authenticates and returns the viewer 367ms
 ✓ test/GitHubLive.test.ts > GitHub live contract (GITHUB_TOKEN) > reports the rate-limit headers the retry policy reads 227ms
 ✓ test/GitHubLive.test.ts > GitHub live contract (GITHUB_TOKEN) > paginates a real Link header 881ms
 ✓ test/GitHubLive.test.ts > GitHub live contract (GITHUB_TOKEN) > classifies a real 404 as a non-retryable delivery failure 225ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  23:59:36
   Duration  3.64s (transform 309ms, setup 0ms, import 1.22s, tests 1.70s, environment 0ms)
```

Exit code: 0.

What the run proved against the live API: `GET /user` authenticates and returns a string login; `GET /rate_limit` returns numeric `limit`, `remaining`, and `reset` under `resources.core`; `paginate("/repos/microsoft/TypeScript/issues", { perPage: 5, maxPages: 2 })` follows a real `Link: rel="next"` header and returns more than 5 items; a real 404 classifies as `reason: "delivery-failed"` with `{ status: 404, retryable: false }` and the token does not appear in the serialized failure details.

### 2. Linear live contract (PASS)

```sh
cd /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-2/packages/integrations
corepack pnpm exec vitest run test/LinearLive.test.ts --coverage.enabled=false --reporter=verbose
```

`LINEAR_API_KEY` came from the ambient shell environment.

Output:

```
 RUN  v4.1.9 .../clean-checkout-2/packages/integrations

 ✓ test/LinearLive.test.ts > Linear live contract (LINEAR_API_KEY) > authenticates and returns the viewer 310ms
 ✓ test/LinearLive.test.ts > Linear live contract (LINEAR_API_KEY) > resolves a real team by key and caches it 638ms
 ✓ test/LinearLive.test.ts > Linear live contract (LINEAR_API_KEY) > lists the workflow states and labels the name resolution depends on 454ms
 ✓ test/LinearLive.test.ts > Linear live contract (LINEAR_API_KEY) > reports a GraphQL error rather than a transport failure 388ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  00:00:07
   Duration  3.51s (transform 292ms, setup 0ms, import 1.25s, tests 1.79s, environment 0ms)
```

Exit code: 0.

What the run proved against the live API: the viewer query returns a string id; the workspace has at least one team, so the two in-suite `ctx.skip` branches did not fire and the team cache claim was exercised (a second `resolveTeam` issued zero additional `fetch` calls); `workflowStates` filtered by team returns an array; an invalid GraphQL field returns `reason: "delivery-failed"` with a message that names Linear and does not contain the key.

### 3. Telegram live contract (ENV-SKIP)

```sh
cd /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-2/packages/integrations
env -u TELEGRAM_BOT_TOKEN -u SMITHERS_TELEGRAM_BOT_TOKEN corepack pnpm exec vitest run test/TelegramLive.test.ts --coverage.enabled=false --reporter=verbose
```

Output:

```
 RUN  v4.1.9 .../clean-checkout-2/packages/integrations

 ↓ test/TelegramLive.test.ts > Telegram live contract (TELEGRAM_BOT_TOKEN) > authenticates and identifies the bot
 ↓ test/TelegramLive.test.ts > Telegram live contract (TELEGRAM_BOT_TOKEN) > long-polls without confirming any update
 ↓ test/TelegramLive.test.ts > Telegram live contract (TELEGRAM_BOT_TOKEN) > reports an unknown method with the API's own error code, and no token

 Test Files  1 skipped (1)
      Tests  3 skipped (3)
   Start at  00:01:07
   Duration  1.15s (transform 373ms, setup 0ms, import 947ms, tests 0ms, environment 0ms)
```

Exit code: 0.

Reason: `TELEGRAM_BOT_TOKEN` and `SMITHERS_TELEGRAM_BOT_TOKEN` are absent on this host. The suite skips with the credential named in its title. Telegram is not an rc.0 release-smoke integration (rc-contract section 3.2 and the suite header). To run it, set `TELEGRAM_BOT_TOKEN` to a BotFather token and rerun the command above without `env -u`.

### 4. Full `@smthrs/integrations` suite with credentials and coverage thresholds (PASS)

```sh
cd /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-2
GITHUB_TOKEN="$(gh auth token)" corepack pnpm --filter @smthrs/integrations test -- --run
```

Final lines:

```
 Test Files  17 passed | 1 skipped (18)
      Tests  311 passed | 3 skipped (314)
   Start at  00:01:20
   Duration  4.57s (transform 10.70s, setup 0ms, import 28.35s, tests 6.29s, environment 2ms)
 % Coverage report from v8
All files          |   98.81 |    94.02 |    98.6 |    99.2 |
=============================== Coverage summary ===============================
Statements   : 98.81% ( 1413/1430 )
Branches     : 94.02% ( 975/1037 )
Functions    : 98.6% ( 282/286 )
Lines        : 99.2% ( 1245/1255 )
================================================================================
```

Exit code: 0.

The one skipped file is `TelegramLive.test.ts` (3 tests). Coverage clears the configured thresholds (`branches 94`, `functions 98`, `lines 99`, `statements 98`) with the live suites contributing provider-side paths.

## Persisted state

The live suites are read-only by design and persist nothing on the vendor side. The `CursorStore.test.ts` suite in the same package run writes cursors through the real `@smthrs/database` SQLite path; it is part of the 311 passing tests. No mocks replace a backend: the Linear suite wraps the installed `fetch` only to count calls and forwards every call to `api.linear.app`.

## Logs

Raw logs, credential patterns redacted before quoting, are in the scratchpad of the session that ran the gate:

- `/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/github-live.log`
- `/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/linear-live.log`
- `/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/telegram-live.log`
- `/private/tmp/claude-501/-Users-williamcory-smithers/b0a4ab15-ceef-429c-8898-089a3db0bc0d/scratchpad/integrations-full.log`

## Notes for the maintainer

- `GITHUB_TOKEN` is not exported in the operator shell. The GitHub suite ran with the `gh` CLI keyring token. The maintainer publish checklist should either export `GITHUB_TOKEN` or record `GITHUB_TOKEN="$(gh auth token)"` as the sanctioned invocation.
- Running a single `*Live.test.ts` file requires `--coverage.enabled=false`; otherwise the package coverage thresholds fail for a reason unrelated to the backend. The README for `packages/integrations` does not state this. This is a documentation gap, not a gate failure.
