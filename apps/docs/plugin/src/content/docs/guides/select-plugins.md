---
title: "Include a plugin conditionally"
description: "Use apply to select a plugin by host target or by a predicate over the pre-resolution configuration, and know what selection does not excuse."
sidebar:
  order: 3
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/plugin/docs/guides/select-plugins.md"
---

A plugin can decide it does not belong in this composition. Declare `apply`,
and the kernel drops the plugin before it contributes a handler, a layer, or a
cache identity.

## Select by host target

`apply: "engine"` and `apply: "harness"` name the host the plugin is for. The
kernel compares the literal with the `target` option, which defaults to
`"engine"`:

```ts
import { Kernel, make } from "@smthrs/plugin"

const list = [
  make({ name: "flows-plugin-shared" }),
  make({ name: "flows-plugin-harness-only", apply: "harness" })
]

// Engine kernel: only flows-plugin-shared is selected.
const engine = Kernel.make(list)

// Harness kernel: both are selected.
const harness = Kernel.make(list, {}, { target: "harness" })
```

A plugin with no `apply` is always selected. This is how one shared preset
serves two hosts: list every plugin once, and let each host take its half.

## Select by a predicate over the configuration

A predicate receives the pre-resolution configuration, the same value you passed
to `Kernel.make`, and returns a boolean:

```ts
const fast = make({
  name: "flows-plugin-fast",
  apply: (config) => config["mode"] === "fast"
})

const kernel = Kernel.make([fast], { mode: "fast" })
```

The configuration a predicate sees is a snapshot taken before the first
predicate runs, so a predicate cannot observe another predicate's side effects,
and a caller cannot mutate the object between two predicate calls.

It is the _pre-resolution_ configuration: the `config` waterfall has not run
yet, so a predicate cannot see a namespace another plugin is about to
contribute. Selection has to settle before the waterfall, because the waterfall
runs the plugins selection chose.

A predicate that throws fails resolution with `apply_failed`, and its raw
failure is not retained. A predicate that returns anything other than a boolean
fails with `invalid_plugin`. Keep predicates pure and total.

## What selection does not excuse

Every plugin record is validated before `apply` runs, so a malformed plugin
fails startup even when the predicate would have excluded it. Selection cannot
hide a typo.

Hook names are checked after selection, and that asymmetry is deliberate: a
shared preset may carry `apply: "harness"` plugins whose hooks only the harness
catalog declares, and it still resolves under a bare engine kernel because those
plugins were never selected.
