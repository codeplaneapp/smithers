---
name: smithers-pause
description: "Gracefully pause a run: stop scheduling new tasks, let in-flight tasks finish, then park it resumably. Run `smithers pause --help` for usage details."
requires_bin: smithers
command: smithers pause
---

# smithers pause

Gracefully pause a run: stop scheduling new tasks, let in-flight tasks finish, then park it resumably.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `runId` | `string` | yes | Run ID to pause |
