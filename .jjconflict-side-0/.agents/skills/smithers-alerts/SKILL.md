---
name: smithers-alerts
description: List and manage durable alert instances. Run `smithers alerts --help` for usage details.
requires_bin: smithers
command: smithers alerts
---

# smithers alerts

List and manage durable alert instances.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | `string` | yes | Alert action: list, ack, resolve, or silence |
| `alertId` | `string` | no | Alert ID for ack/resolve/silence |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|

