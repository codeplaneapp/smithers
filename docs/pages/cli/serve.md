---
description: "Host the control server for this project"
---

# smithers serve

Host the control server for this project.

## Usage

```sh
smithers serve [flags]
```

## Behavior

Hosts the control server (section 10): `/rpc`, `/rpc/ws`, `/sync`, `/sync/ws`, `/projections/ws`, `GET /health`. Loopback default; non-loopback requires `--listen` and a bearer token. `gateway` is an alias for rc.0 only.

## Flags

| Flag | Meaning |
| --- | --- |
| `--host string` | See the behavior above. |
| `--port integer` | See the behavior above. |
| `--listen` | See the behavior above. |

## Source

This page is generated from the binary's `--help` output. Run
`pnpm docs:pages` after changing the command.
