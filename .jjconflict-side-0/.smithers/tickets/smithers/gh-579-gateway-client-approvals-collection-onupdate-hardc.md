# 🐛 gateway-client: approvals collection onUpdate hardcodes approved:true — a deny-shaped update silently approves

GitHub: https://github.com/smithersai/smithers/issues/579

**What happens**
The approvals collection's `onUpdate` handler (`packages/gateway-client/src/data/createSmithersCollections.ts:362-368`) always sends `approved: true, decision: row.decision ?? { approved: true }` to `submitApproval`, regardless of the row's actual decision.

**Why it's wrong / failure scenario**
The gateway handler resolves `approved = asBoolean(params.approved) ?? asBoolean(decision?.approved)` (`packages/server/src/gateway.js:6577`) — the top-level `approved` wins. So a consumer that applies a denial via a collection update carrying `decision: { approved: false }` gets `approveNode` called: the denial is silently converted into an approval. `onDelete` is the intended deny path, but nothing stops (or even warns about) a deny-shaped update.

**Expected behavior**
`approved` mirrors the row: `approved: row.decision?.approved ?? true`, so update-with-denial denies (or is rejected loudly).

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
