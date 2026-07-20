---
name: smithers-human
description: List and resolve durable human requests. Run `smithers human --help` for usage details.
requires_bin: smithers
command: smithers human
---

# smithers human

List and resolve durable human requests.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `action` | `string` | yes | Human request action: inbox, answer, or cancel |
| `requestId` | `string` | no | Human request ID for answer/cancel |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--value` | `string` |  | JSON response for smithers human answer |
| `--by` | `string` |  | Name or identifier of the human operator |
