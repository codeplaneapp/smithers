---
description: "Print the bundled documentation; --full prints llms-full.txt"
---

# smithers docs

Print the bundled documentation; --full prints llms-full.txt.

## Usage

```sh
smithers docs [flags]
```

## Behavior

Prints the bundled `llms.txt` or `llms-full.txt` generated from the vocs `docs/pages` tree (section 9 exception 2, R-25).

## Flags

| Flag | Meaning |
| --- | --- |
| `--full` | See the behavior above. |

## Source

This page is generated from the binary's `--help` output. Run
`pnpm docs:pages` after changing the command.
