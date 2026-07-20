---
name: smithers-bug
description: File a smithers bug report to bug.smithers.sh; with --run it attaches the run's status, error, and last ~50 events (secrets scrubbed). Run `smithers bug --help` for usage details.
requires_bin: smithers
command: smithers bug
---

# smithers bug

File a smithers bug report to bug.smithers.sh; with --run it attaches the run's status, error, and last ~50 events (secrets scrubbed).

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--run` | `string` |  | Attach this run's workflow name, status, error, and recent events to the report |
| `--title` | `string` |  | Bug title (derived from the run's error when omitted) |
| `--body` | `string` |  | Bug description body |
| `--endpoint` | `string` |  | Bug endpoint URL (default https://bug.smithers.sh/api/bugs; the SMITHERS_BUG_ENDPOINT env var takes precedence) |
