---
title: "Control the order handlers run in"
description: "Pick between the plugin-wide enforce group and the per-hook order object, and know which one wins when they disagree."
sidebar:
  order: 2
---

Two levers decide when your handler runs. Use `enforce` when the plugin as a
whole belongs early or late. Use the per-hook `order` when one hook needs a
different position from the rest of the plugin.

## Move the whole plugin with enforce

`enforce` puts a plugin in the `pre`, normal, or `post` group. Within a group,
plugins keep the order you listed them in:

```ts
import { make } from "@smthrs/plugin"

const early = make({ name: "flows-plugin-early", enforce: "pre", hooks: { configResolved: handler } })
const late = make({ name: "flows-plugin-late", enforce: "post", hooks: { configResolved: handler } })
```

The resulting list is the resolved plugin order, and it decides two things
beyond hook dispatch: the order `kernel.layer` merges plugin layers in, and the
order plugin identities appear in a declared cache identity.

## Move one hook with the ordering object

Replace the bare handler with `{ order, handler }` to position that hook alone:

```ts
const plugin = make({
  name: "flows-plugin-mixed",
  hooks: {
    config: handler,
    configResolved: { order: "pre", handler }
  }
})
```

Here `config` runs at the plugin's normal position and `configResolved` runs
early. The object form is the only way to give one plugin two different
positions.

## The per-hook order wins

When the two levers disagree, the per-hook `order` wins, because it is applied
second and re-partitions the already-sorted list:

```ts
const plugins = [
  make({ name: "flows-plugin-a", enforce: "post", hooks: { configResolved: { order: "pre", handler } } }),
  make({ name: "flows-plugin-b", enforce: "pre", hooks: { configResolved: { order: "post", handler } } })
]
// configResolved order: flows-plugin-a, then flows-plugin-b.
```

This is Vite's rule, kept verbatim, so a plugin ported from Vite orders the same
way here. The full statement of it is in
[Resolution](../concepts/resolution.md).

## Do not order by list position alone

Within a group, the array order is stable and it is the tiebreaker. It is also
the weakest of the three signals: a host that concatenates presets, or a user
who reorders a config file, changes it without meaning to. Declare `enforce` or
`order` when the position matters, and leave both off when it does not.

## Ordering is not a dependency system

There is no `dependsOn`, and no cycle detection, because there are no
dependencies to cycle. If your plugin needs another plugin's contribution, read
it from the value the hook threads through: a waterfall handler sees what the
earlier handlers produced, and a `configResolved` observer sees the whole
resolved configuration.
