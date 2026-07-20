# Make createTeam and team.create audit event atomic

GitHub: https://github.com/smithersai/smithers/issues/873

Wrap ControlPlaneStore.createTeam's team INSERT and its team.create audit-event write in one SQLite transaction. Add a regression test proving that an audit-write failure rolls back the team row.
