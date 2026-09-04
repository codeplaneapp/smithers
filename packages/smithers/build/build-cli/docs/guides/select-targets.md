---
title: "Select the targets a command runs"
description: "Turn an intent into an argv: which verb selects which targets, how the label grammar narrows a selection, and what --jobs and --plan change."
sidebar:
  order: 1
---

A `smithers-build` invocation is a verb plus a pattern. The verb decides which
kind of target participates; the pattern decides which packages are in scope.
Getting both right is the whole skill.

## Pick the verb

| You want                                         | Verb                        |
| ------------------------------------------------ | --------------------------- |
| Compile or generate artifacts                    | `build`                     |
| Run test suites                                  | `test`                      |
| Run linters and drift checks                     | `lint`                      |
| Check documentation parity                       | `docs`                      |
| All four at once, over one graph                 | `ci`                        |
| Run a generator, publish, agent task, or commit  | `run`                       |
| Run model reviews                                | `review`                    |
| Run one label whose kind you do not want to name | `target`, or the bare label |

A target participates in a verb when its rule declares that kind. A generator
target participates in both `build` and `lint`, and the two forms differ: the
`lint` form checks for drift and the `build` form writes. That is why `ci`
plans lint first, and why `--write` exists on `target`.

If you select a target under a verb it does not support, the command reports
the unsupported rule rather than returning a false green.

## Narrow with the label grammar

```bash
# every target in the workspace
pnpm exec smithers-build test '//...'

# every target under one subtree
pnpm exec smithers-build test '//packages/...'

# one named target in every package of a subtree
pnpm exec smithers-build test '//packages/...:faults'

# one package's default target
pnpm exec smithers-build test '//packages/smithers/flows/flow'

# one exact target
pnpm exec smithers-build test '//packages/smithers/flows/flow:test'

# a target in the package holding the working directory
pnpm exec smithers-build test ':test'
```

Quote the pattern. `//...` and `:test` are not shell metacharacters today, but
`//pkg/...:name` reads badly unquoted and a glob-expanding shell can surprise
you.

`//pkg/...:name` is the form worth remembering. It runs one shared target key
across every package that declares it, so a matrix is a property of the
packages rather than of a central list. A package that does not declare the
key is simply not selected.

## Check the selection before running it

`query` lists exactly what a pattern selects, and executes nothing:

```bash
pnpm exec smithers-build query '//packages/...:faults'
```

`--plan` goes one step further and shows what running that selection would do,
still without executing:

```bash
pnpm exec smithers-build test '//packages/...' --plan
```

Use `query` when you are unsure the pattern matches. Use `--plan` when you are
unsure the run is safe or want to see which targets the cache already covers.

## Bound the concurrency

`--jobs, -j <n>` caps concurrent targets; the default is the host's available
parallelism. Lower it when targets contend for a shared resource:

```bash
pnpm exec smithers-build test '//packages/...:faults' --jobs 1
```

## Skip the cache for one run

`--no-cache` bypasses cache reads for that invocation and still publishes what
it produces. Reach for it when you suspect a stale result rather than when you
want a clean tree; a stale result is a key bug, and
[Caching](../concepts/caching.md) explains what a key covers.

## Run one label without naming a verb

```bash
pnpm exec smithers-build '//packages/smithers/flows/flow:lint'
```

A first argument starting with `//` or `:` is rewritten to `target <label>`,
which runs the label under the verb its rule implies. This is the shortest
form for a single target, and the only way to run a `review` target without
naming the verb.
