---
name: smithers-cron
description: Manage and run background schedule triggers. Run `smithers cron --help` for usage details.
requires_bin: smithers
command: smithers cron
---

# smithers cron add

Register a new workflow cron schedule.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pattern` | `string` | yes | Cron execution pattern (e.g. '0 * * * *') |
| `workflowPath` | `string` | yes | Path or ID of the workflow to schedule |

---

# smithers cron list

List all registered background cron schedules.

---

# smithers cron rm

Delete an existing cron schedule by ID.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `cronId` | `string` | yes | Cron ID to delete |

---

# smithers cron start

Start the background scheduler loop in the current terminal.
