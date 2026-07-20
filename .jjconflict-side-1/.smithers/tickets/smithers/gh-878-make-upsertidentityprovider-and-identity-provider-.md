# Make upsertIdentityProvider and identity_provider.upsert audit event atomic

GitHub: https://github.com/smithersai/smithers/issues/878

Wrap ControlPlaneStore.upsertIdentityProvider's identity-provider upsert and its identity_provider.upsert audit-event write in one SQLite transaction. Add a regression test proving that an audit-write failure rolls back the provider change.
