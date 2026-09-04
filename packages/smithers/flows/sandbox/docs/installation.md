---
title: "Installation"
description: "Install @smthrs/sandbox, its runtime requirements and import forms, and the vendor SDK or host tool each bundled provider expects you to supply."
sidebar:
  order: 1
---

## Install the package

```bash
pnpm add @smthrs/sandbox
```

The package requires Node.js 22.19.0 or later and ships as ESM and CommonJS
with TypeScript declarations. It has two runtime dependencies,
[`effect`](https://effect.website) and
[`@smthrs/kernel`](/api/kernel), and the second is used only for command line
rendering and POSIX quoting. Nothing else in the workspace is required,
because a sandbox is one way to satisfy Effect's `ChildProcessSpawner` rather
than a member of the closed host list.

## Import forms

The root entry point re-exports every module as a namespace:

```ts
import { Sandbox, SandboxHealth, SandboxSupervision } from "@smthrs/sandbox"
```

Each namespace is also its own subpath, which is the form the API reference
uses:

```ts
import * as ContainerSandbox from "@smthrs/sandbox/ContainerSandbox"
import * as Sandbox from "@smthrs/sandbox/Sandbox"
```

Two subpath forms are blocked in the export map:
`@smthrs/sandbox/internal/*` and `@smthrs/sandbox/<Namespace>/index`.
`@smthrs/sandbox/package.json` is exported.

## What a runnable composition adds

Two providers need Effect's own host services, which a platform package
supplies. On Node:

```bash
pnpm add @effect/platform-node
```

`NodeServices.layer` provides `FileSystem`, `Path`, and `ChildProcessSpawner`
together, which is what `DirectorySandbox`, `ContainerSandbox`,
`KubernetesSandbox`, and `AwsSandbox` are constructed from. The
[Quickstart](./quickstart.md) uses it.

Nothing else is required to run a sandbox. Everything below is per provider.

## What each provider expects

This package owns no vendor dependency. A vendor SDK arrives as an injected
structural slice and a command-line tool arrives as an injected spawner, so
adding a backend costs this package no dependency and costs you only what that
backend needs.

| Provider              | You supply                                                                                                                    | Installed where                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `DirectorySandbox`    | An Effect `FileSystem` and `ChildProcessSpawner`.                                                                             | The host process.                                                                   |
| `JustBashSandbox`     | A [`just-bash`](https://www.npmjs.com/package/just-bash) `Bash` instance and a `FileSystem` mounted over the same tree.       | The host process, or the browser page.                                              |
| `ContainerSandbox`    | A `ChildProcessSpawner`, and a Docker-compatible CLI on `PATH` (`docker` by default; `program: "podman"` for Podman).         | The machine running the provider.                                                   |
| `KubernetesSandbox`   | A `ChildProcessSpawner`, `kubectl` on `PATH`, and a cluster context. The guest image must carry `sh`, `env`, and `base64`.    | The machine running the provider, plus the cluster.                                 |
| `MicrosandboxSandbox` | The [`microsandbox`](https://www.npmjs.com/package/microsandbox) SDK module, and a Microsandbox host that can boot a microVM. | Both.                                                                               |
| `VercelSandbox`       | The `@vercel/sandbox` SDK module, and either an OIDC token or a token, team id, and project id.                               | The host process.                                                                   |
| `DaytonaSandbox`      | A configured Daytona client from the vendor SDK.                                                                              | The host process.                                                                   |
| `AwsSandbox`          | An `@aws-sdk/client-ecs` client, a `ChildProcessSpawner`, and the `aws` CLI plus `session-manager-plugin` on `PATH`.          | The machine running the provider, plus an ECS cluster with execute-command enabled. |
| `CloudflareSandbox`   | The `@cloudflare/sandbox` `getSandbox` function and a Worker binding to a deployed Durable Object namespace.                  | The Worker.                                                                         |

Because the SDK slices are structural, you can satisfy them with a test double
instead of the vendor package. That is how this repository proves seven of the
nine providers; see [Test against a scripted machine](./guides/testing.md).

## Browser bundles

The package is gated as a browser entry point by `scripts/browser-check.mjs`
at the repository root. Nothing under `src/` reads a host global: the
conformance fixture's per-process uniqueness comes from Web Crypto rather than
a process id, because a bundler cannot catch a free `process` identifier that
survives into the bundle and throws in a browser.

`JustBashSandbox` is the provider a browser page can actually run, over a
just-bash interpreter and a filesystem mounted on the same tree. The other
providers bundle, but their transports need a host.

## Next step

Place a flow body on a real machine and read its result in the
[Quickstart](./quickstart.md).
