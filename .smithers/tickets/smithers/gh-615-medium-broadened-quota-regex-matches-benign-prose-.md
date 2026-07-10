# [medium] Broadened quota regex matches benign prose ("reached your weekly …")

GitHub: https://github.com/smithersai/smithers/issues/615

**Severity:** Medium · **Feature:** quota classification · **File:** `packages/agents/src/BaseCliAgent/BaseCliAgent.js:25`

## Problem
The broadened quota pattern

```
/\byou('ve| have)\s+reached\s+(your\s+)?(usage|rate|quota|session|weekly|daily|monthly)\b/i
```

ends at a word boundary **right after the noun** and requires no `limit`/`exceeded` token. So common benign phrases match:

- "you've reached your daily standup"
- "you have reached your weekly summary"
- "you've reached your monthly target"

This release newly added `session|weekly|daily|monthly` to a loosely-anchored alternation that previously only had `usage|rate|quota`, materially widening the false-positive surface.

## Why it matters
Fed through the new `ClaudeCodeAgent` answer-text scan (see the related answer-text classification issue), such a sentence in a normal answer converts a **successful** run into a false `AGENT_QUOTA_EXCEEDED` with no reset time → the gateway never auto-resumes it. The sibling pattern on line 26 correctly requires `(cap|ceiling|limit)` + `(reached|exceeded|hit)`; this one should too.

## Failure scenario
A habit-tracker / summary workflow answer contains "You've reached your weekly goal!". Match → `isError` → `AGENT_QUOTA_EXCEEDED`, no `quotaResetAtMs` → run parked indefinitely, correct answer lost.

## Suggested fix
Require a `limit|exceeded|cap|ceiling` token after the noun (mirror line 26), so a bare "reached your weekly …" no longer classifies as quota.

## Verification
Confirmed empirically that "you have reached your weekly goal", "you've reached your daily standup", "you've reached your monthly target" all match the current regex. `classifyQuotaError.test.js` has only one unrelated negative case; nothing asserts benign weekly/daily/monthly phrases return null.

---
*Found in the pre-0.28.0 review of `v0.27.0..HEAD` (@0ed2c28710), adversarially verified against the code. Part of the `pre-0.28-review` batch.*
