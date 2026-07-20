# 🧹 engine: legacyExecuteTask JSDoc `toolConfig` type omits `traceContext`, which the function reads

GitHub: https://github.com/smithersai/smithers/issues/537

**What happens**
The `@param toolConfig` JSDoc for `legacyExecuteTask` (`packages/engine/src/engine.js:2560`) declares `{ rootDir; allowNetwork; maxOutputBytes; toolTimeoutMs; agentPreflightCache?: WeakMap<object, Promise<void>>; }`, but the function reads `toolConfig.traceContext` (engine.js:3471-3485: `workflowPath`, `workflowHash`, `logDir`, `annotations`), which `runWorkflowBodyDriver` sets when building the tool config (engine.js:~4841).

**Why it's wrong**
The declared type is narrower than actual usage, so JSDoc type-checking of `toolConfig.traceContext` relies on `any` leakage and the doc misleads readers about the contract.

**Expected**
Widen the JSDoc type to include the optional `traceContext` shape (or a named typedef shared with the call site).

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
