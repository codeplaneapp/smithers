# 🐛 usage: Anthropic header probe swallows non-ok responses as a blank 'headers' row instead of reporting the error

GitHub: https://github.com/smithersai/smithers/issues/612

**What happens**
`packages/usage/src/anthropicHeaderUsage.js:37-50` special-cases 401 and 429, then returns `{ source: "headers", windows }` for every other status. A 400 (e.g. a typo'd `SMITHERS_ANTHROPIC_PROBE_MODEL` → model-not-found), 403, 500, or 529 with no rate-limit headers becomes `{ source: "headers", windows: [] }` with no `error`.

**Why it's wrong / failure scenario**
`formatUsageReports.js:46` computes the note as `r.error ?? (r.source === "none" ? "not supported" : "")` — for this shape that's the empty string, so `smithers usage` renders a row with a dash window and an empty USED cell and the user has no signal the probe failed. The OpenAI adapter already guards exactly this (`openaiHeaderUsage.js`: `if (!res.ok && windows.length === 0) return { source: "none", error: \`OpenAI returned ${res.status} with no rate-limit headers\` }`).

**Expected behavior**
Mirror the OpenAI adapter: on `!res.ok` with no parsed windows, return `{ source: "none", error: "Anthropic returned <status> with no rate-limit headers" }`.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
