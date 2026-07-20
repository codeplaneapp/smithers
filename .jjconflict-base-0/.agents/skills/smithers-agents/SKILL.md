---
name: smithers-agents
description: Inspect and register subscriptions and api keys. Run `smithers agents --help` for usage details.
requires_bin: smithers
command: smithers agents
---

# smithers agents add

Register a Smithers agent account (interactive wizard, or non-interactive via flags).

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--provider` | `string` |  | Provider id; omit to launch the interactive wizard |
| `--label` | `string` |  | Unique label, e.g. 'claude-work' |
| `--configDir` | `string` |  | Path to the per-account CLI config dir (subscription providers) |
| `--apiKey` | `string` |  | API key (api-key providers only) |
| `--model` | `string` |  | Default model for this account |
| `--skipLogin` | `boolean` | `false` | Skip the 'is the dir populated?' check (advanced) |
| `--force` | `boolean` | `false` | Register even if no credentials are present |
| `--replace` | `boolean` | `false` | Overwrite an existing account with the same label |
| `--loop` | `boolean` | `false` | Wizard mode only: keep adding accounts until you say done |

---

# smithers agents capabilities

Print a JSON report of the built-in CLI agent capability registries.

---

# smithers agents doctor

Validate built-in CLI agent capability registries and command-surface contracts.

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--json` | `boolean` | `false` | Print the doctor report as JSON |

---

# smithers agents list

List all registered Smithers agent accounts. Use --format json for machine output.

---

# smithers agents remove

Remove a Smithers agent account by label.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `label` | `string` | yes | Account label to remove |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--silent` | `boolean` | `false` | Do not error if the label is not registered |

---

# smithers agents test

Spawn the account's underlying CLI with --version to verify it is reachable.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `label` | `string` | yes | Account label to ping |
