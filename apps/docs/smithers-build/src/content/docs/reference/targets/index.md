---
title: "Targets"
description: "Bazel-style TypeScript workflow orchestration with explicit pnpm installation"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/build/docs/reference/targets/README.md"
---

Every target in `@smthrs/targets`. Each page lists the target's attributes, its
declared inputs, its success and error channels, and whether it executes today.

Import a target by name from the package root:

```ts
import { Smithers } from "@smthrs/targets"
```

## Execution status

The CLI executor supplies the shared exec, generated-file write/check,
documentation-parity, filegroup, LLM-review,
package-manifest, output-capture, scaffold, and install implementations. It
deliberately does not supply the irreversible-exec implementation, so a target
that publishes externally or applies release versioning fails at interpretation
with an `unresolved_action` refusal.

**Cacheable** is the target's own declaration. Under a declared
[Nix environment](/concepts/environments/) the planner overrides `Never`
for the external-tool targets whose only missing key material was the
toolchain: TsBuild, DtsBuild, Typecheck, Vitest, VitestCoverage, NodeTest,
EsLint, BiomeCheck, DepsLint, PackageLint, CargoTest, and CargoLint.

**Executes** means the target's plan runs through its declared CLI verb, either
as a root or as a dependency. **Plans only** means the target is
planned, queried, and graphed normally, but executing it fails on a missing
action implementation. No catalog target ends in `NotImplemented`; that machinery
exists for future additions and is unused. See
[Running targets](/workspace/running-targets/#what-executes).

## Build

| Target                         | Kinds   | Cacheable    | Status   | Summary                                                                        |
| ------------------------------ | ------- | ------------ | -------- | ------------------------------------------------------------------------------ |
| [TsBuild](/reference/targets/ts-build/)         | `build` | Never        | Executes | Builds a JavaScript distribution with `tsc -p` or `tsup`.                      |
| [DtsBuild](/reference/targets/dts-build/)       | `build` | Never        | Executes | Emits type declarations with `tsc --emitDeclarationOnly` or `tsup --dts-only`. |
| [Typecheck](/reference/targets/typecheck/)      | `build` | Never        | Executes | Checks a package with `tsc --noEmit` or TypeScript build mode.                 |
| [ToolBuild](/reference/targets/tool-build/)     | `build` | `cache` attr | Executes | Runs an arbitrary command for a non-TypeScript toolchain.                      |
| [TypedocDocs](/reference/targets/typedoc-docs/) | `build` | Never        | Executes | Generates API documentation with TypeDoc.                                      |
| [NodeBinary](/reference/targets/node-binary/)   | `build` | Never        | Executes | Runs one JavaScript program under the declared runtime, for its files.         |

## Test

| Target                               | Kinds  | Cacheable | Status   | Summary                                                     |
| ------------------------------------ | ------ | --------- | -------- | ----------------------------------------------------------- |
| [Vitest](/reference/targets/vitest/)                  | `test` | Never     | Executes | Runs `vitest run` over a declared test set.                 |
| [VitestCoverage](/reference/targets/vitest-coverage/) | `test` | Never     | Executes | Runs `vitest run` with coverage and thresholds.             |
| [VitestWatch](/reference/targets/vitest-watch/)       | `run`  | Never     | Executes | Runs an interactive `vitest watch` session.                 |
| [NodeTest](/reference/targets/node-test/)             | `test` | Never     | Executes | Runs one JavaScript program whose exit code is the verdict. |
| [CargoTest](/reference/targets/cargo/)                | `test` | Never     | Executes | Runs `cargo test` under the declared Rust toolchain.        |

## Lint

| Target                         | Kinds  | Cacheable | Status   | Summary                                                                               |
| ------------------------------ | ------ | --------- | -------- | ------------------------------------------------------------------------------------- |
| [EsLint](/reference/targets/es-lint/)           | `lint` | Never     | Executes | Runs ESLint over declared source sets with a flat config.                             |
| [BiomeCheck](/reference/targets/biome-check/)   | `lint` | Never     | Executes | Runs `biome check` and `biome format` without writing files.                          |
| [Dprint](/reference/targets/dprint/)            | `lint` | Never     | Executes | Checks formatting with `dprint check`, or rewrites it with `dprint fmt`.              |
| [DepsLint](/reference/targets/deps-lint/)       | `lint` | Never     | Executes | Checks dependency declarations with knip or depcheck.                                 |
| [PackageLint](/reference/targets/package-lint/) | `lint` | Never     | Executes | Checks the published package surface with publint and attw.                           |
| [LlmLint](/reference/targets/llm-lint/)         | `lint` | Never     | Executes | Reviews changed files with a model against a rubric, through the claude or codex CLI. |
| [CargoLint](/reference/targets/cargo/)          | `lint` | Never     | Executes | Runs `cargo fmt --check` or `cargo clippy` under the declared Rust toolchain.         |

## Generation

| Target                                    | Kinds           | Cacheable              | Status                  | Summary                                                                      |
| ----------------------------------------- | --------------- | ---------------------- | ----------------------- | ---------------------------------------------------------------------------- |
| [SortPackageJson](/reference/targets/sort-package-json/)   | `build`, `lint` | Never                  | Executes                | Validates or rewrites `package.json` key ordering.                           |
| [PackageJson](/reference/targets/package-json-gen/)        | `lint` / `run`  | Check only             | Executes                | Expands a typed manifest declaration into check, write, and refresh targets. |
| [GithubCiGen](/reference/targets/github-ci-gen/)           | `build`, `lint` | Effective `check` mode | Executes                | Generates the GitHub Actions CI workflow from declared jobs and targets.     |
| [Owners.Codeowners](/reference/targets/owners-codeowners/) | `build`, `lint` | Never                  | Executes (build system) | Generates `.github/CODEOWNERS` from every package's `owners` declaration.    |
| [Owners.Tree](/reference/targets/owners-tree/)             | `build`, `lint` | Never                  | Executes (build system) | Generates the per-directory `OWNERS` tree in the landing-gate format.        |

## Documentation

| Target                       | Kinds  | Cacheable | Status   | Summary                                                |
| ---------------------------- | ------ | --------- | -------- | ------------------------------------------------------ |
| [DocsParity](/reference/targets/docs-parity/) | `docs` | Always    | Executes | Requires a substantive README beside a package's code. |
| [Markdown.CodeBlocks](/reference/targets/markdown-code-blocks/) | `build`, `test` | Always | Executes | Compiles a page's fenced code blocks; `title=` fences concatenate into files, `fragment` fences are skipped. |

`PackageJson` uses separate targets for checking and source-tree writes.
`GithubCiGen` maps its `lint` verb to the drift-check form. See [Verb-effective attrs](/concepts/targets/#verb-effective-attrs).

## Install, release, and processes

| Target                             | Kinds | Cacheable | Status                        | Summary                                                               |
| ---------------------------------- | ----- | --------- | ----------------------------- | --------------------------------------------------------------------- |
| [PnpmWorkspace](/reference/targets/pnpm-workspace/) | `run` | Never     | Executes                      | Runs the smithers-build install flow for a pnpm workspace.            |
| [NewPackage](/reference/targets/new-package/)       | `run` | Never     | Executes                      | Scaffolds one package named with the invocation's `--name` option.    |
| [Changesets](/reference/targets/changesets/)        | `run` | Never     | Executes                      | Reports Changesets status or applies versioning.                      |
| [NpmPublish](/reference/targets/npm-publish/)       | `run` | Never     | Executes (dry-run by default) | Publishes a package to an npm registry.                               |
| [JsrPublish](/reference/targets/jsr-publish/)       | `run` | Never     | Executes (dry-run by default) | Publishes a package to JSR.                                           |
| [Clean](/reference/targets/clean/)                  | `run` | Never     | Executes                      | Deletes explicitly declared generated paths.                          |
| [Dev](/reference/targets/dev/)                      | `run` | Never     | Executes                      | Runs a long-lived development or watch command.                       |
| [ToolRun](/reference/targets/tool-run/)             | `run` | Never     | Executes                      | Runs one arbitrary external command for its irreversible side effect. |

## File sets

| Target                    | Kinds | Cacheable | Status                   | Summary                                                       |
| ------------------------- | ----- | --------- | ------------------------ | ------------------------------------------------------------- |
| [Filegroup](/reference/targets/filegroup/) | none  | Always    | Executes as a dependency | Names a set of files under one label, composing transitively. |

A group joins no verb, so it is never selected as a root and never performs work
under `build`, `test`, or `lint`. It is still addressable by label, listed by
`query`, and traversed by `deps(...)`.

## Macros

| Name                                                                     | Summary                                                                     |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| [StandardPackage](/reference/targets/standard-package/)                                   | Expands one conventional TypeScript package into `lib`, `test`, and `lint`. |
| [PackageJsonTemplate](/reference/targets/package-json-gen/#templates-and-merge-semantics) | Holds inert workspace-wide manifest defaults.                               |

## Authoring surface

These modules are not targets. They are documented elsewhere.

| Module            | Documented in                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `Target`          | [Writing targets](/extending/writing-targets/), [Targets and targets](/concepts/targets/) |
| `Input`           | [Inputs](/concepts/inputs/)                                                                      |
| `Exec`            | [Actions and boundaries](/concepts/actions-and-boundaries/)                                      |
| `Workspace`       | [Workspace reference](/reference/config/)                                                                     |
| `PackageDefaults` | [Default targets](/extending/default-rules/)                                                     |

## Conventions shared by every tool-running target

- **`cwd`** is the workspace-relative directory the tool starts in. It defaults
  to `"."`, the workspace root. Package-level targets pass their own directory.
  [Dev](/reference/targets/dev/) declares `cwd` without a default, so it is required there.
  [TypedocDocs](/reference/targets/typedoc-docs/), [Changesets](/reference/targets/changesets/),
  [NpmPublish](/reference/targets/npm-publish/), [JsrPublish](/reference/targets/jsr-publish/), and
  [PnpmWorkspace](/reference/targets/pnpm-workspace/) declare no `cwd` at all. `TypedocDocs` and
  `Changesets` run at the workspace root, the publish targets run in the directory
  of their declared manifest, and `PnpmWorkspace` generates its file at the
  workspace root.
- **Tools resolve through `PackageManager.exec`** of the declared package
  manager, so the manager is declared key material rather than a hardcoded
  constant. `ToolBuild`, `Dev`, and the runtime-evaluated helper steps are the
  exceptions.
- **Paths in attrs resolve from `cwd` when the tool runs**, and from the
  declaring package when the planner digests them. A `//`-prefixed path resolves
  from the workspace root in both cases.
- **Success is `Exec.Result`**, `{exitCode, stdout, stderr}`, unless
  the target declares something richer. Producing build targets use `Outputs`.
- **Errors are `Exec.ExecError`**, `{argv, cwd, exitCode, stderr}`, with
  `exitCode: -1` when the spawn itself failed.
