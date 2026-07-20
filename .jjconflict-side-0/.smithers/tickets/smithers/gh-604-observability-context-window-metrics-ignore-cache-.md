# 🐛 observability: context-window metrics ignore cache tokens whenever inputTokens is present

GitHub: https://github.com/smithersai/smithers/issues/604

**What happens**
`apps/observability/src/metrics/trackEvent.js:110-118` — `resolveContextWindowTokens` returns `event.inputTokens` alone when positive, only falling back to `cacheReadTokens + cacheWriteTokens` when inputTokens is absent/zero.

**Why it's wrong / failure scenario**
Providers like Anthropic report cached prompt tokens separately from `input_tokens` (total prompt = input + cache_read + cache_write). A heavily cached agent call — e.g. 200k cached + 2k fresh input — is classified into the `lt_50k` bucket by `classifyContextWindowBucket`, so `smithers.tokens.context_window_bucket_total` and `context_window_per_call` systematically under-report exactly the long-context sessions they exist to surface.

**Expected behavior**
Context-window size = `inputTokens + cacheReadTokens + cacheWriteTokens` (sum of whatever components are present).

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
