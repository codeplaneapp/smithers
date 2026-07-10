# Make createProject and project.create audit event atomic

GitHub: https://github.com/smithersai/smithers/issues/875

Wrap ControlPlaneStore.createProject's project INSERT and its project.create audit-event write in one SQLite transaction. Add a regression test proving that an audit-write failure rolls back the project row.
