# 🐛 graph: classifyClaudeWorkflowNodeKind returns "compute" for legacy dom-extracted Subflow/Sandbox descriptors

GitHub: https://github.com/smithersai/smithers/issues/560

**What happens**
`classifyClaudeWorkflowNodeKind` (packages/graph/src/classifyClaudeWorkflowNodeKind.js:17-31) checks `task.computeFn` (line 23) before `task.meta?.__subflow` (line 27) and `task.meta?.__sandbox` (line 28). The legacy extractor `@smithers-orchestrator/graph/dom/extract` attaches a runtime `computeFn` to Subflow and Sandbox descriptors (packages/graph/src/dom/extract.js:348, 445) alongside `meta.__subflow`/`meta.__sandbox`.

**Why it's wrong / failure scenario**
Any GraphSnapshot built from dom/extract descriptors classifies subflow/sandbox nodes as "compute", contradicting the function's own doc comment which promises subflow/sandbox coverage. Core extract.js descriptors carry no computeFn so the production path classifies correctly — the bug bites consumers of the public `graph/dom/extract` subpath.

**Expected**
Check `meta.__subflow`/`meta.__sandbox` before `computeFn` (safe: no core descriptor carries both), or document that only core-extracted descriptors are supported.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
