# 🐛 integrations: duplicate webhook source id throws IntegrationError with reason "unknown-source"

GitHub: https://github.com/smithersai/smithers/issues/576

**What happens**
`makeIntegrationRuntime` rejects duplicate webhook source ids with `new IntegrationError("unknown-source", \`Duplicate webhook source id "..."\`)` (`packages/integrations/src/core/IntegrationRuntime.js:45`).

**Why it's wrong**
`IntegrationError`'s own doc maps reasons to HTTP statuses (`unknown-source` → 404). A duplicate-configuration programming error is the opposite of an unknown source; anything keying on `reason` (logs, ingress mapping, tests) misclassifies it. The `IntegrationErrorReason` union (`IntegrationError.js:4`) has no fitting member, which is likely why the wrong one was reused.

**Expected behavior**
A distinct reason (e.g. `invalid-config`) added to the union, or a plain `SmithersError("INVALID_INPUT", ...)` since this is a construction-time config error, not an ingress error.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
