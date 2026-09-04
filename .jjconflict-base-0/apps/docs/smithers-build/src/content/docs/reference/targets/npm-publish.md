---
title: "Npm Publish"
description: "Bazel-style TypeScript workflow orchestration with explicit pnpm installation"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/build/docs/reference/targets/npm-publish.md"
---

Publishes a package to an npm registry.

```ts
import { Smithers } from "@smthrs/targets"

export const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })

export const publish = Smithers.NpmPublish({
  packageManager,
  packageJson: Smithers.file("//packages/smithers/flows/flow/package.json"),
  artifacts: [Smithers.glob("//packages/smithers/flows/flow/dist/**/*")],
  deps: [lib, packageLint],
  registry: "https://registry.npmjs.org",
  access: "public",
  provenance: true,
  tag: "latest",
  dryRun: true
})
```

## Attributes

| Name             | Type                            | Default  | Description                                                                                |
| ---------------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `packageManager` | `PackageManager.PackageManager` | required | The declared package manager the tool runs through; its name and version are key material. |
| `packageJson`    | `Input.File`                    | required | The manifest. Its directory is where the publish command runs.                             |
| `artifacts`      | `Array<Input.Declared>`         | required | Built output declarations, digested as key material.                                       |
| `deps`           | `Array<Target.Target>`          | required | Dependency targets: the build, the package lint, and versioning.                           |
| `registry`       | `string`                        | required | Passed as `--registry`.                                                                    |
| `access`         | `"public" \| "restricted"`      | required | Passed as `--access`.                                                                      |
| `provenance`     | `boolean`                       | required | When true, sets `npm_config_provenance=true` in the environment.                           |
| `tag`            | `string`                        | required | The dist-tag, passed as `--tag`.                                                           |
| `dryRun`         | `boolean`                       | `true`   | Append `--dry-run`. A real publish is always an explicit opt-out.                          |

There is no `cwd`. The publish directory is the directory of `packageJson.path`,
with a leading `//` stripped.

## Command

Through the irreversible exec action, because publication changes external
registry state. The argv is `PackageManager.publish` of the declared package
manager. With the pnpm declaration:

```
pnpm publish --registry <registry> --access <access> --tag <tag> --no-git-checks [--dry-run]
```

Environment: `npm_config_provenance=true` when `provenance` is true, otherwise
nothing.

`--no-git-checks` is always passed. Tree policy belongs to the release pipeline,
not the publish step.

`registry`, `access`, and `tag` land on argv even though they mirror the
generated manifest's `publishConfig`, which pnpm also reads. `provenance` rides
the environment so the attribute wins over a stale manifest.

## Inputs

Collected from the attrs: `packageJson`, plus every declaration in `artifacts`.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                                                                                                                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kinds     | `run`                                                                                                                                                                                                              |
| Cacheable | Never                                                                                                                                                                                                              |
| Executes  | **No.** The CLI executor does not provide `ExecIrreversibleLive`, so the `smithers-build/exec-irreversible` action has no implementation in scope and the target fails at interpretation with `unresolved_action`. |

The target is selected by `smithers-build run`, but the normal executor refuses before
publication because the irreversible layer is absent. `build`, `test`, `lint`,
and `ci` never select it as a root.

## See also

- [JsrPublish](/reference/targets/jsr-publish/), which runs after npm publication
- [Changesets](/reference/targets/changesets/), which declares the irreversible exec action
- [PackageJson](/reference/targets/package-json-gen/), which derives publish fields from the build target
