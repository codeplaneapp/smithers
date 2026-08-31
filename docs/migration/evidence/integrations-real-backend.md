# Gate: integrations-real-backend

Verdict: PASS

## Scope

PLAN.md Phase 7 requires "real-backend integration tests for every integration
included in the RC". rc-contract.md (sections 3 and 10, ruling A7) names the
rc.0 integrations: the GitHub, Linear, and Telegram adapters rebuilt as the
private workspace package `@smthrs/integrations`, with GitHub and Linear as
"rc.0's real integrations" that "satisfy the Phase 7 smoke". Telegram is
explicitly "not an rc.0 release-smoke integration" (TelegramLive.test.ts
header); its live suite runs only when a bot token is available.

The real-backend suites live in the clean checkout at
`packages/integrations/test/{GitHubLive,LinearLive,TelegramLive}.test.ts`.
They hit api.github.com, api.linear.app, and api.telegram.org directly with no
fixture server. All calls are read-only.

## Environment

- Checkout: /Users/williamcory/.claude/projects/-Users-williamcory-smithers/a3338dfd-4a32-4134-9477-e9757af89d2c/migration/clean-checkout
- Commit: 9c464343f0cfada6aa36f0a08144ed7cf1f0ce14 (v1/rc0-migration)
- node v24.18.0 (engines requires >=22.19.0), pnpm 11.21.0, bun 1.4.0
- vitest 4.1.9
- Date: 2026-08-30

## Credentials

- GITHUB_TOKEN: exported from `gh auth token` (account roninjin10, scopes
  gist, read:org, repo, workflow). Read-only use.
- LINEAR_API_KEY: present in the shell environment.
- TELEGRAM_BOT_TOKEN / SMITHERS_TELEGRAM_BOT_TOKEN: absent. Not in the
  environment, not in ~/.smithers/config.json or accounts.json. The Telegram
  live suite therefore skips itself, naming the variable in its describe
  title. This is the designed ENV-SKIP path and does not block the gate
  because Telegram is not an rc.0 release-smoke integration.

## Commands and results

1. Full package suite with live credentials, from the clean checkout:

```
cd <clean-checkout>/packages/integrations
GITHUB_TOKEN="$(gh auth token)" pnpm exec vitest run
```

Final output:

```
 Test Files  17 passed | 1 skipped (18)
      Tests  311 passed | 3 skipped (314)
   Duration  2.99s
Statements   : 98.81% ( 1413/1430 )
Branches     : 94.02% ( 975/1037 )
Functions    : 98.6% ( 282/286 )
Lines        : 99.2% ( 1245/1255 )
```

Exit code: 0. Coverage thresholds (94/98/99/98) held. The one skipped file is
TelegramLive.test.ts; the 3 skipped tests are its cases.

2. Live suites alone, verbose, to prove the real-backend cases executed:

```
GITHUB_TOKEN="$(gh auth token)" pnpm exec vitest run \
  --coverage.enabled=false --reporter=verbose \
  test/GitHubLive.test.ts test/LinearLive.test.ts test/TelegramLive.test.ts
```

Final output:

```
 ✓ GitHubLive > authenticates and returns the viewer 262ms
 ✓ GitHubLive > reports the rate-limit headers the retry policy reads 146ms
 ✓ GitHubLive > paginates a real Link header 729ms
 ✓ GitHubLive > classifies a real 404 as a non-retryable delivery failure 215ms
 ✓ LinearLive > authenticates and returns the viewer 208ms
 ✓ LinearLive > resolves a real team by key and caches it 273ms
 ✓ LinearLive > lists the workflow states and labels the name resolution depends on 438ms
 ✓ LinearLive > reports a GraphQL error rather than a transport failure 160ms
 ↓ TelegramLive (3 tests skipped: TELEGRAM_BOT_TOKEN absent)
 Test Files  2 passed | 1 skipped (3)
      Tests  8 passed | 3 skipped (11)
```

Exit code: 0.

## Assessment

- GitHub live contract: 4/4 passed against api.github.com. Covers
  authentication, rate-limit header shape, real Link-header pagination, and
  404 classification with token-redaction assertion.
- Linear live contract: 4/4 passed against api.linear.app. Covers
  authentication, team resolution with cache verification via a counting
  fetch wrapper, workflow state and label listing, and GraphQL error
  classification.
- Telegram live contract: skipped, credential TELEGRAM_BOT_TOKEN (or
  SMITHERS_TELEGRAM_BOT_TOKEN) absent. Telegram is not required for the rc.0
  release smoke per rc-contract section 3.
- The remaining 15 test files (fixture-backed behavior suites, webhook HMAC,
  cursor store on real SQLite files, listener registry, actions) also passed
  in the same run.

The gate requirement, real-backend tests for GitHub and Linear at minimum, is
met with both suites fully passing. PASS.
