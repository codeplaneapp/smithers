---
title: "Installation"
description: "Install @smthrs/memory, its runtime requirements, and the packages you add for production wiring."
sidebar:
  order: 1
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/memory/docs/installation.md"
---

## Requirements

- Node.js 22.19.0 or later. The package's `engines` field enforces this floor.
- The `effect` library, version 4.0.0-rc.108. It is a direct dependency, so the package manager installs it for you.

## Install

```bash
pnpm add @smthrs/memory
```

The package ships as ESM and CommonJS with TypeScript declarations. Its own dependencies (`effect`, `@smthrs/core`, `@smthrs/database`, `@smthrs/model`, `@smthrs/patterns`) install with it.

## Packages you add for production wiring

The in-memory test layer needs nothing beyond the install. A store backed by a database file needs two more packages:

```bash
pnpm add @smthrs/memory @effect/platform-node
```

- `@smthrs/database` is already present as a dependency and provides the SQLite client and the durable writer.
- `@effect/platform-node` provides `NodeCrypto.layer`, the `Crypto.Crypto` service `MemoryStore.layer` requires for generating thread ids.

The [Quickstart](/quickstart/) wires both forms. For the import forms the package publishes (root namespaces, per-module subpaths, the test layer), see [Import surface](/surface/).
