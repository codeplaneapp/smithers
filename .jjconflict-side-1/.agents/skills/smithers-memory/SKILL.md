---
name: smithers-memory
description: View and query cross-run memory facts. Run `smithers memory --help` for usage details.
requires_bin: smithers
command: smithers memory
---

# smithers memory get

Get a single memory fact by namespace + key.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `namespace` | `string` | yes | Namespace (e.g. 'workflow:my-flow') |
| `key` | `string` | yes | Fact key |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--workflow` | `string` |  | Path to a .tsx workflow file (defaults to this workspace's store) |

---

# smithers memory list

List all memory facts in a namespace.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `namespace` | `string` | no | Namespace to list facts for (e.g. 'workflow:my-flow'). Omit to list every namespace. |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--workflow` | `string` |  | Path to a .tsx workflow file (defaults to this workspace's store) |

---

# smithers memory rm

Delete a memory fact by namespace + key.

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `namespace` | `string` | yes | Namespace (e.g. 'workflow:my-flow') |
| `key` | `string` | yes | Fact key |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--workflow` | `string` |  | Path to a .tsx workflow file (defaults to this workspace's store) |

---

# smithers memory set

Set a memory fact (value is stored verbatim as the fact's JSON value).

## Arguments

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `namespace` | `string` | yes | Namespace (e.g. 'workflow:my-flow') |
| `key` | `string` | yes | Fact key |
| `value` | `string` | yes | Fact value (stored as-is) |

## Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--workflow` | `string` |  | Path to a .tsx workflow file (defaults to this workspace's store) |
| `--ttl` | `number` |  | Time-to-live in milliseconds |
