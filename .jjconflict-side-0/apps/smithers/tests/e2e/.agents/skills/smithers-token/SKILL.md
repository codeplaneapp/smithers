---
name: smithers-token
description: Issue and revoke short-lived Gateway bearer tokens. Run `smithers token --help` for usage details.
requires_bin: smithers
command: smithers token
---

# smithers token exec

Resolve an action token locally and inject the bearer into a child process environment.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--handle` | `string` |  | Brokered action token handle |
| `--actionId` | `string` | `gateway` | Action id expected by the brokered token |
| `--scopes` | `string` |  | Comma or space separated scopes required for this action |
| `--env` | `string` | `SMITHERS_API_KEY` | Environment variable that receives the bearer token |
| `--command` | `string` |  | Shell command to run with the injected token |

---

# smithers token issue

Issue a local short-lived Gateway bearer token grant.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--scopes` | `string` | `run:read` | Comma or space separated Gateway scopes |
| `--role` | `string` | `operator` | Role recorded on the token grant |
| `--userId` | `string` |  | User id recorded on the token grant |
| `--ttl` | `string` | `1h` | Token lifetime, such as 15m or 1h |
| `--actionId` | `string` | `gateway` | Action id allowed to resolve the brokered action token |
| `--revealToken` | `boolean` | `false` | Include the raw bearer token in CLI output |

---

# smithers token revoke

Revoke a locally issued Gateway bearer token.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `token` | `string` | yes | Bearer token to revoke |
