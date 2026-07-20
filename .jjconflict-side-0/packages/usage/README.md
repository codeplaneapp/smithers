# @smithers-orchestrator/usage

Report how much rate limit or subscription quota each registered Smithers account
has consumed. Powers `smithers usage`.

```
$ smithers usage
ACCOUNT       PROVIDER      PLAN   WINDOW          USED          RESETS IN
claude-work   claude-code   max    5-hour session  33%           2h 41m
claude-work   claude-code   max    weekly          13%           5d 3h
codex-main    codex         pro    5-hour          12%           4h 02m
codex-main    codex         pro    weekly          40%           6d 1h
openai-ci     openai-api    —      requests/min    820/1000 left 0m 42s
```

## What it reads, per provider

The numbers live in three incompatible shapes, so every adapter normalizes to one
`UsageReport`.

| Provider | Source | Auth read from |
| --- | --- | --- |
| `claude-code` | `GET api.anthropic.com/api/oauth/usage` (5h + weekly %) | `<configDir>/.credentials.json` or macOS Keychain `Claude Code-credentials` |
| `codex` | `GET chatgpt.com/backend-api/wham/usage` (5h + weekly %) | `<configDir>/auth.json` |
| `anthropic-api` | live `anthropic-ratelimit-*` headers off `count_tokens` | account `apiKey` |
| `openai-api` | live `x-ratelimit-*` headers off a `max_tokens:1` POST | account `apiKey` |
| `gemini` / `antigravity` / `gemini-api` | none yet (Google exposes no live quota) | — |
| `kimi`, others | none | — |

The subscription endpoints (`claude-code`, `codex`) are undocumented: they are the
same endpoints the official CLIs call, reachable by reading the CLI's own OAuth
token off disk. They are best-effort — any failure degrades to a `source: "none"`
report with a readable reason, never an exception.

## Design

- `getAccountUsage(account)` is the dispatcher. It switches on `account.provider`,
  mirroring `accountToProviderEnv` in `@smithers-orchestrator/accounts`.
- `getUsageForAccounts(accounts, opts)` fans out in parallel through an on-disk
  cache (`usage-cache.json`). Cached reports come back with `stale: true`. The
  cache enforces a hard 180s floor for `claude-code` because its usage endpoint
  429s aggressively below that.
- Credentials are read on the host that owns them. Only the normalized
  `UsageReport` ever leaves the process — no token is returned or logged.

## Safety

- The Claude usage endpoint requires `User-Agent: claude-code/<ver>` and
  `anthropic-beta: oauth-2025-04-20`. Override the UA with
  `SMITHERS_CLAUDE_CODE_UA` if the installed version matters.
- `--fresh` bypasses the soft cache but never the hard per-provider floor.

See `.smithers/specs/usage-and-limits.md` for the full design and the phased plan
(gateway RPC, studio dashboard, Google local-estimate accounting).
