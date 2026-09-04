---
title: "@smthrs/plugin"
description: "A typed, bounded plugin kernel for Effect programs: Vite-style hooks and ordering, a config waterfall, and a resolution boundary that copies every value a caller hands it."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/plugin/docs/README.md"
---

`@smthrs/plugin` is the extension point a host offers its plugins. It gives you
Vite's plugin model, typed end to end and bounded at every edge: a plugin is a
plain record, a hook is an ordinary Effect, ordering follows Vite's rules
exactly, and no value a caller passes in survives as a live reference into
dispatch.

The kernel owns one hook catalog of its own, the two-step config lifecycle
(`config` and `configResolved`). Every other hook belongs to a host. You declare
your hooks with TypeScript module augmentation, hand the kernel the matching
runtime catalog, and dispatch that catalog and nothing else. The `FlowsHooks`
interface is open for augmentation and closed for dispatch.

## Who uses this package

A **host** assembles a composition and wants third-party code to extend it at
named points. The host declares its hook catalog, calls `Kernel.make`, and gets
back a dispatcher, a frozen configuration, and one merged layer. The shipped
example is the Smithers agent cell host in [`@smthrs/agent`](https://agent.smithers.sh/reference/api/), which
adds three waterfalls to the kernel's two hooks.

A **plugin author** writes a record with a `name` and some `hooks` and hands it
to a host. Nothing about the record is host-specific machinery: there is no base
class, no registration call, and no inheritance.

## What this package does not do

The kernel is not an engine lifecycle registry. Retry, storage, concurrency,
cache, wait, journal, and ownership policy stay on the Effect service or
constructor option that applies them. Configuration refuses the root keys
`engine`, `retry`, `store`, and `plugins` so that a configuration file cannot
imply otherwise.

## Install

```bash
pnpm add @smthrs/plugin effect@4.0.0-rc.108
```

For the runtime requirements and the import forms, see
[Installation](/installation/).

## The smallest real example

A plugin contributes a configuration namespace and reads the resolved result
back:

```ts
import { type FlowsPlugin, Kernel } from "@smthrs/plugin"
import { Effect } from "effect"

const feature: FlowsPlugin = {
  name: "flows-plugin-feature",
  hooks: {
    config: () => Effect.succeed({ feature: { enabled: true } }),
    configResolved: (config) => Effect.log(`feature enabled: ${config["feature"] !== undefined}`)
  }
}

const kernel = await Effect.runPromise(Kernel.make([feature]))
```

`kernel.config` is the frozen, deeply copied configuration every plugin agreed
on. `kernel.plugins` dispatches hooks. `kernel.layer` is every plugin's services
merged in resolved order. `kernel.observerErrors` holds the failures that
`configResolved` observers reported without failing startup.

## Where to go next

- [Installation](/installation/) for the runtime requirements, the import
  forms, and the subpaths that are not public.
- [Quickstart](/quickstart/) to build a host with its own hook, run it, and
  read a typed result.
- [Hook kinds](/concepts/hook-kinds/) for what each of the four dispatch
  shapes promises.
- [Resolution](/concepts/resolution/) for how a plugin list becomes an
  ordered, immutable catalog.
- [Configuration](/concepts/configuration/) for the config waterfall and the
  JSON boundary it enforces.
- [API reference](/reference/api/) for every export, with signatures and limits.
- [Troubleshooting](/troubleshooting/) for each `PluginError` code, what
  causes it, and what to change.
