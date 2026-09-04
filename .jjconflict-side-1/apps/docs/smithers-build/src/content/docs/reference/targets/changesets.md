---
title: "Changesets"
description: "Bazel-style TypeScript workflow orchestration with explicit pnpm installation"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/build/docs/reference/targets/changesets.md"
---

Reports Changesets status, or applies versioning.

```ts
import { Smithers } from "@smthrs/targets"

export const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })

export const releaseStatus = Smithers.Changesets({
  packageManager,
  operation: "status",
  changesets: [Smithers.glob(".changeset/*.md")],
  config: Smithers.file("//.changeset/config.json"),
  rootPackageJson: Smithers.file("//package.json"),
  lockfile: Smithers.file("//pnpm-lock.yaml"),
  deps: [],
  since: "origin/main"
})
```

## Attributes

| Name              | Type                            | Default  | Description                                                                                |
| ----------------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `packageManager`  | `PackageManager.PackageManager` | required | The declared package manager the tool runs through; its name and version are key material. |
| `operation`       | `"status" \| "version"`         | required | Report, or apply versioning.                                                               |
| `changesets`      | `Array<Input.Declared>`         | required | The changeset files, digested as key material.                                             |
| `config`          | `Input.File`                    | required | The Changesets config.                                                                     |
| `rootPackageJson` | `Input.File`                    | required | The root manifest.                                                                         |
| `lockfile`        | `Input.File`                    | required | The lockfile.                                                                              |
| `deps`            | `Array<Target.Target>`          | required | Dependency targets.                                                                        |
| `since`           | `string \| null`                | required | A base revision for `status`, passed as `--since`. Ignored by `version`.                   |

There is no `cwd`. Both operations run at the workspace root.

## Commands

Both argvs are `PackageManager.exec` of the declared package manager.

`status` runs through the shared sealed exec action. With the pnpm declaration:

```
pnpm exec changeset status [--since <since>]
```

`version` runs through the irreversible exec action, because it mutates manifests
and changelogs. With the pnpm declaration:

```
pnpm exec changeset version
```

The irreversible tier means the engine refuses to retry it blindly, and no
verification, replay, or cache-population path may execute it.

## Inputs

Collected from the attrs: every declaration in `changesets`, plus `config`,
`rootPackageJson`, and `lockfile`.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kinds     | `run`                                                                                                                                                                                                        |
| Cacheable | Never                                                                                                                                                                                                        |
| Executes  | `status` yes, through `ExecLive`, as a `run` root or dependency. `version` **no**: the CLI executor does not provide `ExecIrreversibleLive`, so the target fails at interpretation with `unresolved_action`. |

Both operations are selected by `smithers-build run`; `build`, `test`, `lint`, and
`ci` never select them as roots.

## Release order

The intended order is status, version, build and package lint, npm publish, then
JSR publish.

## Shared exports

This module also declares the `ExecIrreversible` action and its
`ExecIrreversibleLive` layer. Both [NpmPublish](/reference/targets/npm-publish/) and
[JsrPublish](/reference/targets/jsr-publish/) use them. The action carries the same payload,
result, and error as the sealed exec action, declared at the `irreversible` tier.

## See also

- [NpmPublish](/reference/targets/npm-publish/)
- [JsrPublish](/reference/targets/jsr-publish/)
- [Actions and boundaries](/concepts/actions-and-boundaries/)
