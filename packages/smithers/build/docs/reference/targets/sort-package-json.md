---
title: "SortPackageJson"
description: "Validates or rewrites package.json key ordering with sort-package-json."
---

Validates or rewrites `package.json` key ordering with `sort-package-json`.

```ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const manifestOrder = Smithers.SortPackageJson({
  packageManager,
  manifests: [Smithers.file("package.json")],
  deps: [],
  check: true,
  cwd: "packages/greeter"
})

export const Package = Smithers.Package({
  targets: { manifestOrder }
})
```

## Attributes

| Name             | Type                            | Default  | Description                                                                                |
| ---------------- | ------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `packageManager` | `PackageManager.PackageManager` | required | The declared package manager the tool runs through; its name and version are key material. |
| `manifests`      | `Array<Input.File>`             | required | The manifests to sort. With none declared, the tool sorts the `package.json` in `cwd`.     |
| `deps`           | `Array<Target.Target>`          | required | Dependency targets.                                                                        |
| `check`          | `boolean`                       | required | Report only instead of rewriting.                                                          |
| `cwd`            | `string`                        | `"."`    | Workspace-relative directory the tool runs in.                                             |

## Command

The argv is `PackageManager.exec` of the declared package manager. With the
pnpm declaration:

```text
pnpm exec sort-package-json [--check] <manifests...>
```

With `check: true` the run only reports, which suits the `lint` verb. Without it
the run rewrites the manifests in place, which suits the `build` verb. Both
forms remain non-cacheable because the external toolchain is not complete key
material.

## Inputs

Collected from the attrs: every entry in `manifests`.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                         |
| --------- | ----------------------- |
| Kinds     | `build`, `lint`         |
| Cacheable | Never                   |
| Executes  | Yes, through `ExecLive` |

Because the target declares both kinds, one target is selected by both
`smithers-build build` and `smithers-build lint`. `smithers-build ci` merges the two plans and runs it
once.

Under `lint`, `SortPackageJson` forces `check: true`, so lint never rewrites a
manifest. Under `build`, it uses the declared value. `PackageJson` instead
exposes separate check and write targets.

## See also

- [PackageJson](package-json-gen.md) for declaring and checking a manifest
- [PackageLint](package-lint.md)
