---
description: "Run the serve system flow"
---

# smithers serve

Run the serve system flow.

## Usage

```sh
smithers serve [flags] [<key=value...>]
```

## Behavior

Hosts the control server (section 10): `/rpc`, `/rpc/ws`, `/sync`, `/sync/ws`, `/projections/ws`, `GET /health`. Loopback default; non-loopback requires `--listen` and a bearer token. `gateway` is an alias for rc.0 only.

## Flags

| Flag | Meaning |
| --- | --- |
| `--data string` | See the behavior above. |

## Source

This page is generated from the binary's `--help` output and section 4.1 of the
[release contract](https://github.com/smithersai/smithers/blob/main/docs/migration/rc-contract.md).
Run `pnpm docs:pages` after changing either.
