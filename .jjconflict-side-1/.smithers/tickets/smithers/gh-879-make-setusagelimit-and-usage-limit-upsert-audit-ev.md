# Make setUsageLimit and usage_limit.upsert audit event atomic

GitHub: https://github.com/smithersai/smithers/issues/879

Wrap ControlPlaneStore.setUsageLimit's usage-limit upsert and its usage_limit.upsert audit-event write in one SQLite transaction. Add a regression test proving that an audit-write failure rolls back the limit change.
