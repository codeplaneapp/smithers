---
title: "Vitest"
description: "Bazel-style TypeScript workflow orchestration with explicit pnpm installation"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/build/docs/reference/targets/vitest.md"
---

Runs a non-watch `vitest run` over a declared test set.

```ts
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../../../../../PACKAGE.ts"

export const test = Smithers.Vitest({
  packageManager,
  tests: [Smithers.glob("test/**/*.test.ts")],
  sources: [Smithers.glob("src/**/*.ts")],
  deps: [lib],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd: "packages/smithers/flows/flow"
})
```

## Attributes

| Name              | Type                            | Default  | Description                                                                                                                                                     |
| ----------------- | ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packageManager`  | `PackageManager.PackageManager` | required | The declared package manager the tool runs through; its name and version are key material.                                                                      |
| `tests`           | `Array<Input.Declared>`         | required | Test file declarations. Digested as key material.                                                                                                               |
| `sources`         | `Array<Input.Declared>`         | required | Source declarations, so a source edit re-keys the run.                                                                                                          |
| `deps`            | `Array<Target.Target>`          | required | Dependency targets, usually the package's `lib`.                                                                                                                |
| `config`          | `Input.File \| null`            | required | The Vitest config, or `null` to pass no `--config`.                                                                                                             |
| `environment`     | `string`                        | required | The Vitest environment, for example `node` or `jsdom`.                                                                                                          |
| `coverage`        | `boolean`                       | `true`   | Whether the run may compute coverage. `false` renders `--coverage.enabled=false`, which a config with coverage enabled needs on an engine with no V8 inspector. |
| `passWithNoTests` | `boolean`                       | required | Succeed when the suite matches no files.                                                                                                                        |
| `cwd`             | `string`                        | `"."`    | Workspace-relative directory the runner starts in.                                                                                                              |

## Command

The argv is `PackageManager.exec` of the declared package manager. With the
pnpm declaration:

```
pnpm exec vitest run [--config <config.path>] --environment <environment> [--coverage.enabled=false] [--passWithNoTests]
```

The target passes no file arguments. Vitest discovers test files itself; the
declared `tests` control the cache key.

## Inputs

Collected from the attrs: every declaration in `tests` and `sources`, plus
`config` when it is not `null`.

## Channels

| Channel | Type             |
| ------- | ---------------- |
| Success | `Exec.Result`    |
| Error   | `Exec.ExecError` |

## Status

|           |                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------- |
| Kinds     | `test`                                                                                          |
| Cacheable | Under a declared Nix environment; never otherwise, the executable toolchain is not key material |
| Executes  | Yes, through `ExecLive`                                                                         |

## See also

- [VitestCoverage](/reference/targets/vitest-coverage/) for coverage and thresholds
- [VitestWatch](/reference/targets/vitest-watch/) for an interactive session
- [StandardPackage](/reference/targets/standard-package/), which emits a `Vitest` `test` target
