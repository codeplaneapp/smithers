# 🐛 graph(extract): [medium] numeric-string `retries` prop is not coerced, silently becomes Infinity (unbounded) retries

GitHub: https://github.com/smithersai/smithers/issues/707

_via ultracode (Opus multi-agent) review_

**Summary:** A `retries` prop that arrives as a numeric string (e.g. from MDX `retries="0"`) is not recognized as explicit and silently defaults to `Infinity` retries — the opposite of the author's intent.

**Location:** `packages/graph/src/extract.js:105` (gate), `:121` (Infinity fallthrough); also HumanTask guard at `:657-659`.

**Details:**
- `resolveRetryConfig(raw)` computes `hasExplicitRetries = typeof raw.retries === "number" && !Number.isNaN(raw.retries)` (line 105). A string like `"0"` fails this check.
- `raw` is `node.rawProps` (line 393), stored verbatim by the reconciler (`rawProps: props ?? {}`, no coercion).
- With `hasExplicitRetries === false` and no `noRetry`/`continueOnFail`, `retries` falls through to `Infinity` (line 121).
- Sibling props ARE coerced: `maxConcurrency` (line 285) and `subtreeConcurrency` (line 310) both use `Number(...)` with the comment "Coerce numeric strings (e.g. from MDX)". `retries`, `timeoutMs`, and `heartbeatTimeoutMs` are the un-coerced outliers.

**Failure scenario:** An MDX workflow (or a TSX string-literal typo) writes `<Task id="build" output={T} agent={claude} retries="0">`. `rawProps.retries === "0"`. `resolveRetryConfig` sees `hasExplicitRetries=false` → returns `retries=Infinity`. A task the author explicitly capped at 0 retries instead retries forever on a persistent failure (auth/quota/logic error).

**Why it matters:** A capped or disabled retry budget silently becoming infinite is a durability/quota footgun — a permanently-failing task loops indefinitely, burning agent quota and never surfacing failure, undetectable at graph-build time. It also defeats the HumanTask finite-`maxAttempts` guard (line 657), which only triggers when `raw.retries` is a `number`.

**Fix sketch:** Coerce `raw.retries` with `Number(...)` (mirroring the maxConcurrency block) before the `typeof === "number"` check, and apply the same to `timeoutMs`/`heartbeatTimeout(Ms)` in `parseHeartbeatTimeoutMs`.
