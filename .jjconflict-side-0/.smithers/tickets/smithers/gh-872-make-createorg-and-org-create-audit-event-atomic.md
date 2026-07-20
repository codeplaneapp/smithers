# Make createOrg and org.create audit event atomic

GitHub: https://github.com/smithersai/smithers/issues/872

Wrap ControlPlaneStore.createOrg's org INSERT and its org.create audit-event write in one SQLite transaction. Add a regression test proving that an audit-write failure rolls back the org row.
