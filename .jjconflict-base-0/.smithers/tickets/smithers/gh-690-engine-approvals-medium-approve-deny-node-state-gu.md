# 🐛 engine(approvals): [medium] approve/deny node-state guard runs outside the transaction (TOCTOU → contradictory event log)

GitHub: https://github.com/smithersai/smithers/issues/690

_via ultracode (Opus multi-agent) review_

**Summary:** `resolveApprovalNode` validates the node's `waiting-approval` state *before* opening the transaction and never re-checks it inside, so concurrent approve/deny decisions on the same node can both commit — emitting both an `ApprovalGranted` and an `ApprovalDenied` event for a single gate.

**Location:** `packages/engine/src/approvals.js:76-112` (guard at 76-78 is outside `withTransactionEffect` opened at 79; writes at 80-103 are unconditional upserts using pre-transaction `currentNode`).

**Failure scenario:**
1. Fiber/process A (`approveNode`) and B (`denyNode`) target the same `(runId, nodeId, iteration)` while it is `waiting-approval` — e.g. a gateway approve racing a CLI/MCP deny, or the auto-approver racing a manual decision.
2. Both read `getNode` (77) and pass `validateNodeWaitingForApproval` (78) before either opens its transaction.
3. `withTransactionEffect` (adapter.js:931) serializes the *writes*, but the guard is outside the turn, so both transactions run. `insertOrUpdateApproval`/`insertNode` are unconditional (no status-`WHERE`), so final approval row and node state (`pending` vs `failed`) are last-writer-wins / interleaving-dependent.
4. Each call independently appends its event (`insertEventWithNextSeq`, 119-124), updates `approvalWaitDuration`, and calls `bridgeApprovalResolve`.

Callers pass no upstream lock: `packages/server/src/serve.js:299/306`, `gateway.js:7028/7032`, `index.js:1358/1376`, `apps/cli/src/index.js:6523/6650`, `apps/cli/src/mcp/semantic-tools.js:1335/1338`. Cross-process callers on a shared DB bypass the in-memory transaction turn entirely.

**Why it matters:** A human-in-the-loop gate ends with a contradictory durable event history (both grant and deny), nondeterministic node terminal state, duplicate metric emissions, and two bridge resolves.

**Fix:** Re-fetch and re-validate node/approval status *inside* `withTransactionEffect`, or make `insertOrUpdateApproval`/`insertNode` conditional on current status (compare-and-set) so only the first decision wins.
