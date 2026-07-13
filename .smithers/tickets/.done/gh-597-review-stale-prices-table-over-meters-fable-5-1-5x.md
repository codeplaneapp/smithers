# 🐛 review: stale PRICES table over-meters Fable 5 (1.5x) and Opus 4.8/4.7 (3x), under-meters Haiku 4.5 (~20%)

GitHub: https://github.com/smithersai/smithers/issues/597

**What happens**
`apps/review/src/server/proxy/modelPrices.ts:16-20` bills `claude-fable-5`, `claude-opus-4-8`, and `claude-opus-4-7` at $15 input / $75 output per MTok (cacheWrite 18.75, cacheRead 1.5), and `claude-haiku-4-5` at $0.8/$4.

**Why it's wrong**
Current Anthropic pricing is Fable 5 = $10/$50, Opus 4.8/4.7 = $5/$25, Haiku 4.5 = $1/$5 (`claude-sonnet-4-6` at $3/$15 is correct). At the documented 1.25x cache-write / 0.1x cache-read multipliers the rows should be:
- `claude-fable-5`: `{ input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1.0 }`
- `claude-opus-4-8` / `claude-opus-4-7`: `{ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }`
- `claude-haiku-4-5`: `{ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }`

These prices feed `recordUsage` cost_usd, which drives both the per-session spend cap and the repo monthly cap enforced in `handleAnthropic.ts:103-120` — so Opus/Fable sessions get 402 "spend cap exhausted" at 1/3 of their real budget, and Haiku spend is under-metered ~20%.

**Expected behavior**
PRICES matches current Anthropic list pricing; spend caps trip at the intended dollar amounts.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).


> Closed by ticket-fleet: landed on main in 2f7a246e431e030d2f3d334e04f5fbe04ea5d485.
