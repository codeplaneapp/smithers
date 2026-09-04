---
title: "Filegroup"
description: "Names a set of files under one label so other targets depend on the set instead of repeating its globs."
area: targets
order: 100
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/build/targets/docs/reference/filegroup.md"
---

A group names a set of files under one label: declared files, declared globs, and other groups, expanded as one deduplicated union. A minimal declaration names its sources and the package directory they resolve from:

```ts
import { Smithers } from "@smthrs/targets"

const protos = Smithers.Filegroup({
  srcs: [Smithers.glob("proto/**/*.proto")],
  cwd: "packages/wire"
})

export const Package = Smithers.Package({ targets: { protos } })
```

## Attributes

The attrs schema declares two fields:

| Name   | Type                                               | Default    | Description                                                                                                                                         |
| ------ | -------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `srcs` | `Array<Input.File \| Input.Glob \| Target.Target>` | `required` | The files, globs, and targets the group names, in read order. A target that is not a group contributes no files.                                     |
| `cwd`  | `string`                                           | `"."`      | Package directory the declared paths and patterns resolve from. The default is the declaring `PACKAGE.ts` package; another value is workspace relative. |

## Behavior

The implementation plans one `ExpandFilegroup` action call whose payload is the flattened source list `Filegroup.sources` builds from `srcs`. The walk is depth first in `srcs` order and enters each nested group once, so a diamond of groups contributes its shared members once and the flattening is deterministic. Nested sources resolve against the nested group's own `cwd`. A target in `srcs` that is not a group is skipped by the flattening and stays an ordinary dependency edge.

The declared files and globs inside `srcs` are collected by `Target.make` as declared inputs, so the group's own key carries their digests, and nested groups are dependency edges, so their keys reach the group's key. The planner adds the files of every group reachable from a consumer to that consumer's read set, so editing any member invalidates every target that names the group. Globs expand through `Input.expandGlob`, which is package scoped and applies `.gitignore`; the expansion is deduplicated by path and sorted, and a named file that does not exist digests to null instead of failing.

`kinds` is empty, so `smithers-build build`, `test`, `lint`, and `docs` never select a group as a root. Dependency traversal, `smithers-build query`, and `smithers-build graph` ignore kinds, so a group is still addressable by label and still traversed by `deps(...)`. Under a Flow runtime, a group reached as a dependency records one `ExpandFilegroup` call that reads the named files and succeeds with them digested, which needs `ExpandFilegroupLive`. Under `smithers-build`, the group node settles green without spawning a process, and its files reach the consumer through the read set and the consumer's key.

## Channels

The declaration passes these channel schemas:

| Channel | Type                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------ |
| Success | `Filegroup.Files`, an array of `{ path, digest }` entries sorted by path, with a null digest for a missing file |
| Error   | `Filegroup.FilegroupError`, a tagged error with a `message` field, raised on a filesystem error                |

## Status

The catalog row and the `Target.make` call state:

| Property         | Value                                                     |
| ---------------- | --------------------------------------------------------- |
| Kinds            | none                                                      |
| Cacheable        | yes                                                       |
| Declares outputs | no                                                        |
| Route            | flow body                                                 |
| Executes         | Yes, through `ExpandFilegroupLive`, and only as a dependency |

## Example

A group composes with a sibling group and reaches a test target as a dependency:

```ts
import { Smithers } from "@smthrs/targets"

const cwd = "packages/wire"

/** The proto sources and the schema every wire target reads. */
const wireInputs = Smithers.Filegroup({
  srcs: [Smithers.glob("proto/**/*.proto"), Smithers.file("schema.json")],
  cwd
})

/** The same set plus the code generated from it. */
const wireSources = Smithers.Filegroup({
  srcs: [wireInputs, Smithers.glob("src/generated/**/*.ts")],
  cwd
})

const test = Smithers.Vitest({
  tests: [Smithers.glob("test/**/*.test.ts")],
  sources: [Smithers.glob("src/**/*.ts")],
  deps: [wireSources],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

export const Package = Smithers.Package({ targets: { test, wireInputs, wireSources } })
```

The group joins no verb, so the consumer's verb is what reaches it:

```bash
smithers-build test //packages/wire:test
```

## See also

- [Agent.Diff](https://smithers.sh/docs/reference/targets/agent-diff/), a rule that names a group in its `data`
- [The `@smthrs/targets` package](https://smithers.sh/docs/reference/api/targets/)

## Sources

- `packages/smithers/build/targets/src/Filegroup.ts`
- `packages/smithers/build/targets/src/Input.ts`
- `packages/smithers/build/targets/src/Package.ts`
- `packages/smithers/build/targets/docs/rules.md`
- `packages/smithers/build/targets/README.md`
- `packages/smithers/build/build-cli/src/PackageExec.ts`
- `packages/smithers/build/docs/reference/targets/filegroup.md`
