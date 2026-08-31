# Phase 7 gate: integrations-real-backend

Verdict: **PASS**.

GitHub and Linear, the two rc.0 real integrations (rc-contract section 3.2, `@smthrs/integrations` row, ruling A7; PLAN Phase 7 "real-backend integration tests for every integration included in the RC"), pass their real-backend contract suites against `api.github.com` and `api.linear.app` from the clean checkout at `cd14388ed7`. Telegram, the third adapter in the package, is **ENV-SKIP**: neither `TELEGRAM_BOT_TOKEN` nor `SMITHERS_TELEGRAM_BOT_TOKEN` exists on this host, and the rc-contract names Telegram as not an rc.0 release-smoke integration. The full `@smthrs/integrations` suite, fixture and live together, passes with its coverage thresholds.

This file supersedes the 2026-08-31 00:03 PT evidence taken at `20b32c6316` in `migration/clean-checkout-2`. The superseded file is kept beside this one as `integrations-real-backend-prev-20b32c6316.md`. `git diff --stat 20b32c6316..cd14388ed7 -- packages/integrations` is empty: the package under test did not change between the two runs, and the 20 commits in the range touch `packages/{agent,cli,control,engine-store,testing,flows}`, `apps/*`, `scripts/*`, and docs.

## Scope

rc-contract section 3.2 defines the rc.0 integration set: the GitHub, Linear, and Telegram clients rebuilt on the action, notification, and trigger APIs as `@smthrs/integrations` (private at rc.0, rule (d)), with webhook ingress as library code bound to `@smthrs/control` `WebhookChannel`. Section 3.2 and ruling A7 both state: "GitHub and Linear are rc.0's real integrations and satisfy the Phase 7 smoke." D15 confirms every other vendor or host adapter moved to the plugins repository or was deleted. Section 10 (Plue cutover) names no additional integration.

Real-backend suites in the clean checkout, found by listing `packages/integrations/test`, by `find` for `*Live*.test.ts` outside `legacy/` and `node_modules/`, and by grepping every test file for `process.env.*(TOKEN|API_KEY|SECRET|SMOKE)`:

| Suite | Backend | Credential variable (test reads, in order) | Writes |
| --- | --- | --- | --- |
| `packages/integrations/test/GitHubLive.test.ts` | `https://api.github.com` | `GITHUB_TOKEN`, then `SMITHERS_GITHUB_TOKEN` | none |
| `packages/integrations/test/LinearLive.test.ts` | `https://api.linear.app/graphql` | `LINEAR_API_KEY`, then `SMITHERS_LINEAR_API_KEY` | none |
| `packages/integrations/test/TelegramLive.test.ts` | `https://api.telegram.org` | `TELEGRAM_BOT_TOKEN`, then `SMITHERS_TELEGRAM_BOT_TOKEN` | none (`getUpdates` with no offset and a zero timeout confirms nothing) |

Each suite is `describe.skipIf(<credential> === undefined)` and names the credential in its title, so a skip is visible in the report.

Out of scope, with the reason:

- `packages/control/test/ControlLive*.test.ts`, `packages/engine-store/test/LeaseLiveness.test.ts`, `packages/platform-node/test/HostLiveness.test.ts`: engine liveness suites over local SQLite, not vendor integrations. The unit-tests gate runs them.
- `apps/review/tests/publishService.e2e.test.ts` (`SMITHERS_REVIEW_PUBLISH_TOKEN` or `~/.smithers-review.json`): `@smthrs/review` is a `private: true` app, not an `@smthrs/integrations` adapter, and rc-contract section 3.2 keeps apps out of the release set.
- `packages/targets` and `packages/build-cli` tests that read `SMITHERS_CACHE_TOKEN`: the private build graph's hosted cache, run by the unit-tests gate against local fixtures.
- `packages/build-cli/test/AgentSession.test.ts` (`SMTHRS_CODEX_SMOKE=1`) and `packages/harness/test/WorkerdSmoke.test.ts` (`FLOWS_WORKERD_SMOKE=1`): opt-in agent CLI and workerd smokes.
- `examples/test/12-agent-live-smoke.test.ts` (`OPENAI_API_KEY`) and `apps/review/tests/reviewPullRequest.e2e.test.ts` (`ANTHROPIC_API_KEY`): model-seat smokes owned by the examples gate and the private review app.

## Environment

| Item | Value |
| --- | --- |
| Checkout | `/Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4` |
| Branch and HEAD | `v1/rc0-migration` at `cd14388ed782aac6e5f5b23d66c8fa9dc01dd6ba` (equals `v1/rc0-migration` in `/Users/williamcory/smithers`) |
| `git status --short` | empty before and after every command below |
| `git submodule status` | ` 47589ada70c12b3e829b5c98ab32503abad49eac vendor/jj (v0.25.0-3759-g47589ada7)` |
| Host | macOS, Darwin 25.2.0, arm64 |
| Node | `v24.18.0` (rc-contract section 1 floor is `>=22.19.0`) |
| Bun | `1.4.0` (not used by this gate; the package tests run under vitest on Node) |
| pnpm | `11.21.0` through `corepack`, matching `packageManager: pnpm@11.21.0` |
| vitest | `4.1.9` |
| Date | 2026-08-31 05:00 to 05:02 PDT |

`SMITHERS_HOME` was unset in the calling shell and additionally stripped from every pnpm invocation with `env -u SMITHERS_HOME`.

Credential presence, checked by name only (values never printed or logged):

| Variable | State | Source used |
| --- | --- | --- |
| `GITHUB_TOKEN` | unset in the shell | Supplied per command as `GITHUB_TOKEN="$(gh auth token)"`. `gh auth status`: logged in to github.com as `roninjin10` via keyring, scopes `gist`, `read:org`, `repo`, `workflow`. The suite is read-only. |
| `SMITHERS_GITHUB_TOKEN`, `GH_TOKEN` | unset | not needed |
| `LINEAR_API_KEY` | set in the shell | ambient environment |
| `SMITHERS_LINEAR_API_KEY` | unset | not needed |
| `TELEGRAM_BOT_TOKEN` | unset | absent |
| `SMITHERS_TELEGRAM_BOT_TOKEN` | unset | absent |

Telegram credential search, by variable name only: the shell environment; `~/.smithers/.env`, `~/.smithers/env`, `~/smithers/.env`, `~/smithers/.env.local`, `~/.config/smithers/.env` (all absent); `~/.zshrc`, `~/.zshenv`, `~/.zprofile` (present, zero assignments); the macOS keychain (`security find-generic-password -s TELEGRAM_BOT_TOKEN` and `-s SMITHERS_TELEGRAM_BOT_TOKEN`, both not found). No credential exists on this host.

Network preflight, unauthenticated, before the suites:

```
api.github.com GET /rate_limit           HTTP 200
api.linear.app POST /graphql (no key)    HTTP 401
api.telegram.org GET / (no token)        HTTP 302
```

## Commands and results

### 0. Frozen install

```sh
cd /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4
env -u SMITHERS_HOME corepack pnpm install --frozen-lockfile --offline
```

Final lines:

```
Scope: all 64 workspace projects
Already up to date
Done in 1.4s using pnpm v11.21.0
```

Exit code: 0. `git status --short` after the install: empty.

### 1. GitHub live contract (PASS)

The package's `vitest.config.ts` enables v8 coverage with thresholds (`branches 94`, `functions 98`, `lines 99`, `statements 98`) by default. A single live file cannot reach those thresholds, so the isolated runs disable coverage; command 4 measures coverage over the whole suite. Command 5 records what happens without the flag.

```sh
cd /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4/packages/integrations
GITHUB_TOKEN="$(gh auth token)" env -u SMITHERS_HOME corepack pnpm exec vitest run test/GitHubLive.test.ts --coverage.enabled=false --reporter=verbose
```

Output:

```
 RUN  v4.1.9 .../clean-checkout-4/packages/integrations

 ✓ test/GitHubLive.test.ts > GitHub live contract (GITHUB_TOKEN) > authenticates and returns the viewer 342ms
 ✓ test/GitHubLive.test.ts > GitHub live contract (GITHUB_TOKEN) > reports the rate-limit headers the retry policy reads 225ms
 ✓ test/GitHubLive.test.ts > GitHub live contract (GITHUB_TOKEN) > paginates a real Link header 873ms
 ✓ test/GitHubLive.test.ts > GitHub live contract (GITHUB_TOKEN) > classifies a real 404 as a non-retryable delivery failure 140ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  05:00:33
   Duration  3.04s (transform 432ms, setup 0ms, import 1.15s, tests 1.58s, environment 0ms)
```

Exit code: 0.

What the run proved against the live API: `GET /user` authenticates and returns a string `login`; `GET /rate_limit` returns numeric `limit`, `remaining`, and `reset` under `resources.core`; `paginate("/repos/microsoft/TypeScript/issues", { perPage: 5, maxPages: 2 })` follows a real `Link: rel="next"` header and returns more than 5 items; a real 404 classifies as `reason: "delivery-failed"` with `{ status: 404, retryable: false }` and the token does not appear in the serialized failure.

### 2. Linear live contract (PASS)

```sh
cd /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4/packages/integrations
env -u SMITHERS_HOME corepack pnpm exec vitest run test/LinearLive.test.ts --coverage.enabled=false --reporter=verbose
```

`LINEAR_API_KEY` came from the ambient shell environment.

Output:

```
 RUN  v4.1.9 .../clean-checkout-4/packages/integrations

 ✓ test/LinearLive.test.ts > Linear live contract (LINEAR_API_KEY) > authenticates and returns the viewer 435ms
 ✓ test/LinearLive.test.ts > Linear live contract (LINEAR_API_KEY) > resolves a real team by key and caches it 281ms
 ✓ test/LinearLive.test.ts > Linear live contract (LINEAR_API_KEY) > lists the workflow states and labels the name resolution depends on 672ms
 ✓ test/LinearLive.test.ts > Linear live contract (LINEAR_API_KEY) > reports a GraphQL error rather than a transport failure 455ms

 Test Files  1 passed (1)
      Tests  4 passed (4)
   Start at  05:00:55
   Duration  2.66s (transform 272ms, setup 0ms, import 601ms, tests 1.84s, environment 0ms)
```

Exit code: 0.

What the run proved against the live API: the viewer query returns a string id; the workspace has at least one team, so neither in-suite `ctx.skip` branch fired and the team-cache claim was exercised (a second `resolveTeam` issued zero additional `fetch` calls, counted by a wrapper that forwards every call to `api.linear.app`); `workflowStates` filtered by team returns an array; an invalid GraphQL field returns `reason: "delivery-failed"` with a message that names Linear and does not contain the key.

### 3. Telegram live contract (ENV-SKIP)

```sh
cd /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4/packages/integrations
env -u SMITHERS_HOME -u TELEGRAM_BOT_TOKEN -u SMITHERS_TELEGRAM_BOT_TOKEN corepack pnpm exec vitest run test/TelegramLive.test.ts --coverage.enabled=false --reporter=verbose
```

Output:

```
 RUN  v4.1.9 .../clean-checkout-4/packages/integrations

 ↓ test/TelegramLive.test.ts > Telegram live contract (TELEGRAM_BOT_TOKEN) > authenticates and identifies the bot
 ↓ test/TelegramLive.test.ts > Telegram live contract (TELEGRAM_BOT_TOKEN) > long-polls without confirming any update
 ↓ test/TelegramLive.test.ts > Telegram live contract (TELEGRAM_BOT_TOKEN) > reports an unknown method with the API's own error code, and no token

 Test Files  1 skipped (1)
      Tests  3 skipped (3)
   Start at  05:00:59
   Duration  1.05s (transform 377ms, setup 0ms, import 858ms, tests 0ms, environment 0ms)
```

Exit code: 0.

Reason: `TELEGRAM_BOT_TOKEN` and `SMITHERS_TELEGRAM_BOT_TOKEN` are absent on this host (search recorded under Environment). The suite skips with the credential named in its title. Telegram is not an rc.0 release-smoke integration (rc-contract section 3.2, ruling A7, and the suite header). To run it, set `TELEGRAM_BOT_TOKEN` to a BotFather token and rerun the command above without the `-u` flags.

### 4. Full `@smthrs/integrations` suite with credentials and coverage thresholds (PASS)

```sh
cd /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4
GITHUB_TOKEN="$(gh auth token)" env -u SMITHERS_HOME corepack pnpm --filter @smthrs/integrations test -- --run
```

Final lines:

```
 Test Files  17 passed | 1 skipped (18)
      Tests  311 passed | 3 skipped (314)
   Start at  05:01:30
   Duration  7.17s (transform 21.60s, setup 0ms, import 45.55s, tests 10.11s, environment 18ms)
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

The one skipped file is `TelegramLive.test.ts` (3 tests). Coverage clears every configured threshold. The numbers match the `20b32c6316` run exactly, consistent with the empty package diff between the two commits.

### 5. README single-file command as written (documentation defect, not a gate failure)

`packages/integrations/README.md` lines 155 to 157 document:

```sh
GITHUB_TOKEN=…  pnpm --filter @smthrs/integrations exec vitest run test/GitHubLive.test.ts
```

Run as written (coverage left at the package default):

```sh
cd /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout-4
GITHUB_TOKEN="$(gh auth token)" env -u SMITHERS_HOME corepack pnpm --filter @smthrs/integrations exec vitest run test/GitHubLive.test.ts
```

Final lines:

```
 Test Files  1 passed (1)
      Tests  4 passed (4)
ERROR: Coverage for lines (6.53%) does not meet global threshold (99%)
ERROR: Coverage for functions (6.64%) does not meet global threshold (98%)
ERROR: Coverage for statements (6.29%) does not meet global threshold (98%)
ERROR: Coverage for branches (5.01%) does not meet global threshold (94%)
```

Exit code: 1.

All four live tests pass; the non-zero exit comes from the package-wide coverage thresholds in `packages/integrations/vitest.config.ts` (`coverage.enabled: true`). The README's three documented commands therefore exit 1 for every operator who runs one. Fix: append `--coverage.enabled=false` to the three README commands, or document `pnpm --filter @smthrs/integrations test -- --run` with the credentials exported as the sanctioned live invocation. This does not change the gate verdict: the real-backend contract holds and the sanctioned whole-suite command exits 0.

## Persisted state

The live suites are read-only by design and persist nothing on the vendor side. `CursorStore.test.ts` in the same package run writes cursors through the real `@smthrs/database` SQLite path and is part of the 311 passing tests. No mock replaces a backend: the client and webhook suites drive a `node:http` fixture server over a real socket, and the Linear live suite wraps the installed `fetch` only to count calls and forwards every call to `api.linear.app`.

## Logs

Raw logs, with `gho_`, `ghp_`, `github_pat_`, and `lin_api_` patterns redacted before copying and re-scanned for those patterns after copying (zero hits), are beside this file in `integrations-real-backend-logs/`:

- `install.log`
- `github-live.log`
- `linear-live.log`
- `telegram-live.log`
- `integrations-full.log`
- `readme-command-probe.log`

## Notes for the maintainer

- `GITHUB_TOKEN` is not exported in the operator shell. The GitHub suite ran with the `gh` CLI keyring token. The maintainer publish checklist should either export `GITHUB_TOKEN` or record `GITHUB_TOKEN="$(gh auth token)"` as the sanctioned invocation.
- `packages/integrations/README.md:155-157` documents single-file live commands that exit 1 (command 5). A fix lane should add `--coverage.enabled=false` to those three lines. Small, documentation only, no code change.
- The README credentials table lists `SMITHERS_LINEAR_API_KEY` as the only Linear variable the client reads (`src/linear/Config.ts:66` agrees), while the live suite also accepts `LINEAR_API_KEY` as a test-only convenience. The two statements are consistent: the client's environment lookup and the test's credential lookup are different surfaces.
