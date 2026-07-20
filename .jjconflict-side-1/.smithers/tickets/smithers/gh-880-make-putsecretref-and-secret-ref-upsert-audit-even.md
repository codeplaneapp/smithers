# Make putSecretRef and secret_ref.upsert audit event atomic

GitHub: https://github.com/smithersai/smithers/issues/880

Wrap ControlPlaneStore.putSecretRef's secret-reference upsert and its secret_ref.upsert audit-event write in one SQLite transaction. Add a regression test proving that an audit-write failure rolls back the secret-reference change.
