# 🐛 usage: [low] failed claude-code probes are cached and pinned by the 180s hard floor, un-clearable by --fresh

GitHub: https://github.com/smithersai/smithers/issues/722

_via ultracode (Opus multi-agent) review_

## Summary
`getUsageForAccounts` caches failed probes (`source:"none"` + `error`) exactly like successful ones, then the claude-code 180s hard floor re-serves them regardless of `--fresh`, so a single transient failure blinds the quota view for 3 minutes with no override.

## Code
- `packages/usage/src/getUsageForAccounts.js:60-64` — every report where `!useCache` is written to the on-disk cache with **no filter on `report.source`/`report.error`**; a failed probe's `fetchedAt` is stamped to now.
- `packages/usage/src/getUsageForAccounts.js:49-52` — `useCache = ... (ageMs < hardFloorMs(provider) || (!fresh && ...))`. The `ageMs < hardFloorMs` term is OR'd **before and independent of `fresh`**. For claude-code `hardFloorMs = 180_000` (line 30).
- `packages/usage/src/claudeOauthUsage.js:29-57` — all failures (missing/expired creds, 401, 429, non-ok, timeout) degrade to `{source:"none", error}` rather than throwing, so they flow into the cache as normal reports.

## Failure scenario
Clearest variant (no network involved): a claude-code account's OAuth token is expired → probe returns `{source:"none", error:"Claude OAuth token expired; run \`claude\` to refresh"}`, cached at T0. User runs `claude` to refresh, then `smithers usage --fresh` at T0+30s. `ageMs=30000 < 180000` → `useCache=true` regardless of `fresh`, so the stale "token expired" error is re-served. For a full 180s, even `--fresh` refuses to re-probe the now-valid account — despite the credential path never touching the rate-limited endpoint. Same holds for transient 429/timeout: endpoint recovers but `--fresh` shows the failure until T0+180s.

## Why it matters
The hard floor exists to protect the aggressively rate-limiting Claude usage endpoint from repeated *successful* re-probes. Caching *failed* probes — especially the credential failures that return before any `fetch` — and pinning them under that floor is outside the floor's purpose and defeats `--fresh`: a transient blip or a just-refreshed token can't be re-probed for 3 minutes. Fix: don't cache `source:"none"`/error reports (or exempt cached error reports from the hard floor) so a recovered account can be re-probed. Note other providers have `hardFloorMs=0`, so `--fresh` already recovers there — this is claude-code-specific.
