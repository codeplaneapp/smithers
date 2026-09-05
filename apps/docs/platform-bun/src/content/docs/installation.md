---
title: "Installation"
description: "Install @smthrs/platform-bun, the @effect/platform-bun peer dependency it imports at module load, the CPython 3 interpreter the filesystem slot needs, and the import forms for each entry point."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/platform-bun/docs/installation.md"
---

## Install the package and its peer

```bash
pnpm add @smthrs/platform-bun@1.0.0-rc.0 @smthrs/platform-node@1.0.0-rc.0 @effect/platform-node@4.0.0-rc.112 @effect/platform-bun@4.0.0-rc.112 effect@4.0.0-rc.112
```

Version 1.0.0-rc.0 is not on npm yet. Until it is published, take the package
from [the repository](https://github.com/smithersai/smithers); the rest of this
page applies either way.

`@smthrs/platform-node@1.0.0-rc.0`, `@effect/platform-node@4.0.0-rc.112`, and
`effect@4.0.0-rc.112` are required peers for the shared filesystem and Node
fallback. The Effect adapters own their node-shared implementation dependency.

`@effect/platform-bun` is a required peer at exactly `4.0.0-rc.112` because
the root entry point and `@smthrs/platform-bun/BunHost` import it at module
load. Package managers that resolve required peers install it automatically.
`effect`, `@effect/platform-node`, and `@effect/platform-node-shared` are also
exact peers at that version, so the host shares one compatible Effect runtime.

## Supported runtimes

Bun 1.4.0 or later, and Node.js 22.19.0 or later. Both are declared in
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

The bundle resolves `node:` built-ins, so it does not bundle for a browser. A
page composes [`@smthrs/platform-browser`](https://platform-browser.smithers.sh/reference/api/) instead.

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

The `Jj` slot spawns the `jj` command from
[Jujutsu](https://jj-vcs.github.io), a version-control system that works on a
Git repository. This package vendors no binaries, so install Jujutsu yourself if
your program uses that slot; [`@smthrs/jj`](https://jj.smithers.sh/reference/api/) documents the resolution
order and the `SMITHERS_JJ_PATH` override.

## Next step

Run a command and a file operation through the host in the
[Quickstart](/quickstart/).
