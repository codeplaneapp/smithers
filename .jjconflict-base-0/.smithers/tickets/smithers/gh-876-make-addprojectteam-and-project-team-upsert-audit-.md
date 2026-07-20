# Make addProjectTeam and project.team.upsert audit event atomic

GitHub: https://github.com/smithersai/smithers/issues/876

Wrap ControlPlaneStore.addProjectTeam's project-team upsert and its project.team.upsert audit-event write in one SQLite transaction. Add a regression test proving that an audit-write failure rolls back the association change.
