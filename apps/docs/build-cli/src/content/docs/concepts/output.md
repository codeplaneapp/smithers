---
title: "Output and renderers"
description: "Two output channels: the structured envelope on standard output for programs, and one of three progress renderers on standard error for people, plus how --ui auto chooses."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/build/build-cli/docs/concepts/output.md"
---

The CLI writes to two streams and never mixes them.

**Standard output belongs to the structured envelope.** incur prints the
command's return value there, TOON by default, or JSON, YAML, Markdown, or
JSONL under `--format`. A program reading `smithers-build query --format json`
sees exactly the envelope and nothing else.

**Standard error belongs to progress.** A reporter turns execution events into
whatever the selected renderer draws. Because progress never touches standard
output, `--format json` is never contaminated by a spinner.

## The three renderers

| Renderer | What it draws                                                                             |
| -------- | ----------------------------------------------------------------------------------------- |
| `plain`  | One line per settled target and one summary line. Bare text, no colour, no cursor motion. |
| `stream` | The same events with colour, glyphs, and aligned columns, and still no cursor motion.     |
| `tty`    | Draws in place: running targets spin at the bottom, settled targets scroll above them.    |

`plain` prints exactly the lines the executors have always printed, which is
what pipes, CI logs, and the existing tests read. `stream` is safe wherever
colour is, including a log file that will be read later. `tty` works the way
Bazel's progress bar and Nx's dynamic renderer do.

## How auto resolves

`--ui` takes `auto`, `tty`, `stream`, or `plain`, and defaults to `auto`. An
explicit mode always wins. Under `auto`, the resolution runs in this order and
stops at the first match:

1. `SMTHRS_UI` names a mode, in the manner of Turborepo's `TURBO_UI` and Nx's
   `NX_TUI`.
2. An explicit `--format` means a program is reading, so `plain`.
3. `NO_COLOR` is set, or `TERM=dumb`, so `plain`.
4. `CI` is set: `plain`, unless `FORCE_COLOR` asks for colour, in which case
   `stream`, because a cursor must never move in a log.
5. Both streams are terminals: `tty`.
6. Standard error alone is a terminal, or `FORCE_COLOR` is set under a pipe:
   `stream`.
7. Anything else: `plain`.

## What a person sees instead of the envelope

When a human renderer is selected and incur agrees standard output belongs to
the person rather than to an agent, the CLI renders the result as text on
standard output and returns no envelope data. `query`, `graph`, and `owners`
each have a text form for exactly this: aligned columns for a listing, a tree
for a graph, a table for owners.

Two consequences follow.

- A green execution summary a renderer already drew leaves standard output
  empty. The information was not lost; it was drawn on standard error as it
  happened.
- A red execution summary a renderer already explained records only the exit
  code, so the envelope's error block is not printed a second time.

`graph --mermaid` is the exception in the other direction. Mermaid is meant
for a file or a renderer, never a terminal, so that form is always returned as
data.

## Reading output from a program

Ask for the format you want and read standard output:

```bash
pnpm exec smithers-build query 'deps(//packages/smithers/flows/flow:lib)' --format json
pnpm exec smithers-build ci '//packages/...' --plan --format json
pnpm exec smithers-build graph '//packages/...' --mermaid > graph.mmd
```

An explicit `--format` also forces the `plain` renderer, so progress on
standard error stays parseable and the two streams can be captured separately.
