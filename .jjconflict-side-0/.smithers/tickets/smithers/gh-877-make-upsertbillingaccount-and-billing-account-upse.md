# Make upsertBillingAccount and billing.account.upsert audit event atomic

GitHub: https://github.com/smithersai/smithers/issues/877

Wrap ControlPlaneStore.upsertBillingAccount's billing-account upsert and its billing.account.upsert audit-event write in one SQLite transaction. Add a regression test proving that an audit-write failure rolls back the billing change.
