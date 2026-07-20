# 🧹 control-plane: _smithers_cp_usage_limits lacks the composite project FK its sibling tables declare

GitHub: https://github.com/smithersai/smithers/issues/564

**What happens**
`_smithers_cp_usage_limits` (packages/control-plane/src/index.js:139-150) declares only `FOREIGN KEY (org_id) REFERENCES _smithers_cp_orgs ON DELETE CASCADE`. Its sibling project-scoped tables all additionally declare `FOREIGN KEY (org_id, project_id) REFERENCES _smithers_cp_projects(org_id, project_id) ON DELETE CASCADE`: usage_events (index.js:132-133), secret_refs (166-167, and the migration copy at 228-229), audit_events (180-181).

**Why it matters**
If a project row is ever deleted (org kept), that project's usage events, secret refs, and audit events cascade away, but its usage-limit rows are orphaned with a dangling `project_id` (`assertProjectExists` only guards insert time in `setUsageLimit`). There is currently no deleteProject API in this module, so this only bites via direct SQL or a future delete path — filing to keep the schema consistent before one lands.

**Expected**
Same composite FK + cascade as the sibling tables.

Found during the 2026-07 repo-wide cleanup sweep (automated analyzer, human-unverified).


> Closed by ticket-fleet: landed on main in 6b0b02f736ff0bec45b491eb21a2ab1df6c89283.
