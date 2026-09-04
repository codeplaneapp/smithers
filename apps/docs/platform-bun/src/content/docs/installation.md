---
title: "Installation"
description: "Install @smthrs/platform-bun, the @effect/platform-bun peer dependency it imports at module load, the CPython 3 interpreter the filesystem slot needs, and the import forms for each entry point."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-bun/docs/installation.md"
---

## Install the package and its peer

```bash
pnpm add @smthrs/platform-bun @effect/platform-bun@4.0.0-rc.108
```

Install both. `@effect/platform-bun` is declared as an optional peer
dependency, which means a package manager will not fetch it for you, and both
the root entry point and `@smthrs/platform-bun/BunHost` import it at module
load. Without it, the first `import { BunHost } from "@smthrs/platform-bun"`
throws `ERR_MODULE_NOT_FOUND` for
`@effect/platform-bun/BunChildProcessSpawner`.

The one entry point that resolves without it is
`@smthrs/platform-bun/BunFileSystem`, which imports nothing from
`@effect/platform-bun`.

The version must match the `effect` release the rest of your composition is
built against. This package is built against `effect@4.0.0-rc.108`.

## Supported runtimes

Bun 1.3.0 or later, and Node.js 22.19.0 or later. Both are declared in
`engines`, and both are real: the bundle falls back to the
`@effect/platform-node` adapters off Bun, so it runs unchanged under Node. See
[Runtime parity with Node](/concepts/runtime-parity/) for what that does and
does not buy you.

## Install CPython 3 for the filesystem slot

The filesystem slot is `@smthrs/platform-node`'s `AtomicFileSystem`, which
carries the kernel's atomic host extension. That extension does not run
in-process: it executes each guarded path operation through a CPython 3 helper
so the operation is descriptor-relative and no-follow. The host therefore needs
an interpreter that supports `O_NOFOLLOW`, `O_DIRECTORY`, and `dir_fd`, at
`/usr/bin/python3`:

```bash
/usr/bin/python3 --version
```

macOS ships one. Most Linux distributions either ship one or install it with
the distribution's `python3` package. If your image keeps python3 somewhere
else, build the layer with `BunFileSystem.layerWith({ executable })`; see
[Run where python3 is not at /usr/bin/python3](/guides/configure-the-filesystem-helper/).

Windows is unsupported for this slot.

## Import forms

The root entry point re-exports both modules as namespaces:

```ts
import { BunFileSystem, BunHost } from "@smthrs/platform-bun"
```

Each module is also importable from its own subpath, which is the form the
[API reference](/reference/api/) uses:

```ts
import * as BunFileSystem from "@smthrs/platform-bun/BunFileSystem"
import * as BunHost from "@smthrs/platform-bun/BunHost"
```

Two subpath forms are blocked in the export map and are not public:
`@smthrs/platform-bun/internal/*` and `@smthrs/platform-bun/*/index`.
`@smthrs/platform-bun/package.json` is exported.

The bundle resolves `node:` built-ins, so it is on the repository's
`NODE_ONLY` list and is not browser bundleable. A page composes
[`@smthrs/platform-browser`](https://platform-browser.smithers.sh/reference/api/) instead.

## What a real composition adds

`BunHost.layer` provides the raw host. Two additions are common:

- [`@smthrs/kernel`](https://kernel.smithers.sh/reference/api/) guards it. Its `FileSystem.layer`,
  `ChildProcessSpawner.layer`, `HttpClient.layer`, `Jj.layer`, and `Path.layer`
  decorate the very tags this bundle provides, in place, so a capability check
  runs before every host call. The guarded filesystem is also where the atomic
  extension earns its keep, and it needs a `Workspace` root and a `GrantStore`.
- A `ProcessLedger`, from `@smthrs/kernel/ProcessLedger`, is required by
  `BunHost.layerContained` and `BunHost.layerContainedAt`. It is a requirement
  rather than a default because only your program knows whether it has a
  durable journal to write to. See
  [Contain and reap child processes](/guides/contain-child-processes/).

The `Jj` slot spawns the `jj` executable, which this package does not vendor.
Install jj yourself if your program uses that slot;
[`@smthrs/jj`](https://jj.smithers.sh/reference/api/) documents the binary and the `SMITHERS_JJ_PATH`
override.

## Next step

Run a command and a file operation through the host in the
[Quickstart](/quickstart/).
