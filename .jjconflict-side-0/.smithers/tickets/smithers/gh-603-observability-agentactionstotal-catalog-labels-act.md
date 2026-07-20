# 🐛 observability: agentActionsTotal catalog labels (action_name/action_type) never match the emitted tags (action_kind/phase/level/entry_type/ok)

GitHub: https://github.com/smithersai/smithers/issues/603

**What happens**
`apps/observability/src/metrics/smithersMetricCatalog.js:303-307` declares `agentActionsTotal` labels as `["action_name", "action_type", "engine", "source"]`. The actual emission (`apps/observability/src/metrics/trackEvent.js:502-510`, AgentEvent "action" case) tags the counter with `action_kind`, `phase`, `level`, `entry_type`, `ok`, plus base tags `engine` and `source`.

**Why it's wrong**
`action_name` and `action_type` never occur in any emitted series; `action_kind`/`phase`/`level`/`entry_type`/`ok` occur but are undeclared. Anything driven by catalog metadata — docs, dashboards, default-line generation — describes label sets that don't exist. The stale `_coreMetrics.js` copy (line 128) repeats the wrong set.

**Expected behavior**
Catalog labels `["action_kind", "engine", "entry_type", "level", "ok", "phase", "source"]`, matching trackEvent.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).
