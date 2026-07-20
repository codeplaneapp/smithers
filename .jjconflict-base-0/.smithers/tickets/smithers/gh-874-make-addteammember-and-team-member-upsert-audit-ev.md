# Make addTeamMember and team.member.upsert audit event atomic

GitHub: https://github.com/smithersai/smithers/issues/874

Wrap ControlPlaneStore.addTeamMember's member upsert and its team.member.upsert audit-event write in one SQLite transaction. Add a regression test proving that an audit-write failure rolls back the membership change.
