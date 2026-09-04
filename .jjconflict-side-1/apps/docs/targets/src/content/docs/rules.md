---
title: "Rules"
description: "Typed legacy declaration rules and macros for smithers build"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/build/targets/docs/rules.md"
---

<!-- Hand-maintained. `scripts/docs.mjs` and `docs/Manifest.ts` generated this
     file until the rc.0 docs-tooling dissolution removed them; a rule that is
     added, re-verbed, or made cacheable has to be edited in here by hand until
     a generator is declared again. -->


Every rule `Target.make` declares in this package, with the verbs it
participates in, whether its results may be replayed from the cache,
whether it declares an output tree, and which route executes it. A
`package executor` rule plans `Target.notImplemented` as its Flow body, so
running one under a bare Flow runtime fails loudly instead of doing nothing.

| Rule                     | Module            | Verbs              | Cacheable | Declares outputs | Route            |
| ------------------------ | ----------------- | ------------------ | --------- | ---------------- | ---------------- |
| `Agent.Diff`             | AgentTarget       | run                | no        | no               | flow body        |
| `Agent.Lint`             | AgentTarget       | lint               | no        | no               | flow body        |
| `Agent.Pr`               | AgentTarget       | run                | no        | no               | flow body        |
| `Alias`                  | Compose           | mirrors its target | no        | no               | package executor |
| `Anvil.Fork`             | Anvil             | run                | no        | no               | package executor |
| `Api.Compat`             | NodeArtifact      | test               | yes       | no               | flow body        |
| `BiomeCheck`             | BiomeCheck        | lint               | no        | no               | flow body        |
| `Bundler.Rspack.build`   | BundlerTarget     | build              | yes       | yes              | flow body        |
| `Bundler.Rspack.resolve` | BundlerTarget     | build              | yes       | no               | flow body        |
| `Cargo.AppSet`           | Cargo             | none               | no        | no               | flow body        |
| `Cargo.Build`            | Cargo             | build              | no        | no               | package executor |
| `Cargo.Clippy`           | Cargo             | lint               | no        | no               | package executor |
| `Cargo.Deny`             | Cargo             | lint               | no        | no               | package executor |
| `Cargo.Doc`              | Cargo             | build, docs        | no        | no               | flow body        |
| `Cargo.Fetch`            | Cargo             | build              | no        | no               | package executor |
| `Cargo.Fmt`              | Cargo             | lint               | no        | no               | package executor |
| `Cargo.Nextest`          | Cargo             | test               | no        | no               | package executor |
| `Cargo.Test`             | Cargo             | test               | no        | no               | package executor |
| `Changesets.Publish`     | ChangesetsTarget  | run                | no        | no               | flow body        |
| `Changesets.Version`     | ChangesetsTarget  | run, lint          | by attrs  | no               | package executor |
| `Clean`                  | Compose           | run                | no        | no               | package executor |
| `Copy`                   | NodeArtifact      | build              | yes       | no               | package executor |
| `Cron`                   | CronTarget        | run                | no        | no               | package executor |
| `DepsLint`               | DepsLint          | lint               | no        | no               | flow body        |
| `Dev`                    | Dev               | run                | no        | no               | flow body        |
| `Docker.Bake`            | Docker            | build              | yes       | yes              | package executor |
| `Docker.Build`           | Docker            | build              | yes       | yes              | package executor |
| `Docker.Push`            | Docker            | run                | no        | no               | package executor |
| `Docker.Serve`           | Docker            | run                | no        | no               | package executor |
| `Docker.Service`         | Docker            | run                | no        | no               | package executor |
| `DocsParity`             | DocsParity        | docs               | yes       | no               | flow body        |
| `Dprint`                 | Dprint            | lint               | no        | no               | flow body        |
| `DtsBuild`               | DtsBuild          | build              | no        | yes              | flow body        |
| `EsLint`                 | EsLint            | lint               | no        | no               | flow body        |
| `Fetch`                  | Fetch             | build              | no        | yes              | package executor |
| `Filegroup`              | Filegroup         | none               | yes       | no               | flow body        |
| `Foundry.Build`          | Foundry           | build              | yes       | yes              | flow body        |
| `Foundry.Fmt`            | Foundry           | lint, run          | by attrs  | no               | flow body        |
| `Foundry.Test`           | Foundry           | test               | yes       | no               | flow body        |
| `Generate`               | Compose           | run, lint          | no        | no               | flow body        |
| `Git.Commit`             | GitTarget         | run                | no        | no               | package executor |
| `Git.Pr`                 | GitTarget         | run                | no        | no               | package executor |
| `Git.Submodule`          | GitTarget         | build              | yes       | no               | package executor |
| `Git.Submodules`         | GitTarget         | build              | yes       | no               | flow body        |
| `Github.Ci`              | GithubTarget      | run, lint          | no        | no               | package executor |
| `Github.CiGen`           | GithubTarget      | run, lint          | no        | no               | package executor |
| `Github.Pages`           | GithubTarget      | run                | no        | no               | package executor |
| `Github.Pr`              | GithubTarget      | run                | no        | no               | package executor |
| `Github.Release`         | GithubTarget      | run                | no        | no               | package executor |
| `Github.Setup`           | GithubTarget      | run, lint          | no        | no               | package executor |
| `Github.Workflow`        | GithubTarget      | run, lint          | no        | no               | package executor |
| `GithubCiGen`            | GithubCiGen       | build, lint        | by attrs  | no               | flow body        |
| `Go.Binary`              | Go                | build              | no        | no               | package executor |
| `Go.Fuzz`                | Go                | test               | no        | no               | package executor |
| `Go.Generate`            | Go                | lint, run          | no        | no               | flow body        |
| `Go.Lint`                | Go                | lint               | no        | no               | package executor |
| `Go.ModDownload`         | Go                | build              | no        | no               | package executor |
| `Go.Packages`            | Go                | build              | no        | no               | package executor |
| `Go.Test`                | Go                | test               | no        | no               | package executor |
| `ImportClosure`          | Compose           | build              | no        | no               | flow body        |
| `Install`                | Install           | run                | no        | no               | flow body        |
| `JsrPublish`             | JsrPublish        | run                | no        | no               | flow body        |
| `Literal`                | NodeArtifact      | build              | yes       | no               | package executor |
| `LlmLint`                | LlmLint           | review             | no        | no               | flow body        |
| `Lockfile`               | Lockfile          | build              | no        | yes              | flow body        |
| `Markdown.CodeBlocks`    | NodeArtifact      | build, test        | yes       | no               | package executor |
| `Materialize`            | Compose           | run                | no        | no               | package executor |
| `Memory.Retain`          | MemoryTarget      | run                | no        | no               | package executor |
| `NewPackage`             | NewPackage        | run                | no        | no               | flow body        |
| `NodeBinary`             | NodeBinary        | build              | no        | no               | flow body        |
| `NodeTest`               | NodeTest          | test               | no        | no               | flow body        |
| `Npm.Downstream`         | NpmTarget         | test               | yes       | no               | package executor |
| `Npm.Pack`               | NpmTarget         | build              | yes       | no               | package executor |
| `Npm.Publish`            | NpmTarget         | run                | no        | no               | package executor |
| `Npm.Published`          | NpmTarget         | build              | yes       | no               | package executor |
| `NpmPublish`             | NpmPublish        | run                | no        | no               | flow body        |
| `Overlay`                | NodeArtifact      | build              | yes       | no               | package executor |
| `Owners.Codeowners`      | Owners            | build, lint        | no        | no               | package executor |
| `Owners.Tree`            | Owners            | build, lint        | no        | no               | package executor |
| `PackageJsonCheck`       | PackageJson       | lint               | yes       | no               | flow body        |
| `PackageJsonWrite`       | PackageJson       | run                | no        | no               | flow body        |
| `PackageLint`            | PackageLint       | lint               | no        | no               | flow body        |
| `PnpmWorkspace`          | PnpmWorkspaceFile | build, lint        | no        | yes              | flow body        |
| `Shell.Build`            | Shell             | build              | no        | no               | flow body        |
| `Shell.Diff`             | Shell             | run, lint          | no        | no               | flow body        |
| `Shell.Run`              | Shell             | run                | no        | no               | flow body        |
| `Shell.Serve`            | Shell             | run                | no        | no               | package executor |
| `Shell.Test`             | Shell             | test               | no        | no               | flow body        |
| `Size.Budgets`           | NodeArtifact      | test               | yes       | no               | package executor |
| `SortPackageJson`        | SortPackageJson   | build, lint        | no        | yes              | flow body        |
| `Suite`                  | Compose           | test               | no        | no               | package executor |
| `Test`                   | Compose           | test               | no        | no               | flow body        |
| `ToolBuild`              | ToolBuild         | build              | by attrs  | yes              | flow body        |
| `ToolRun`                | ToolRun           | run                | no        | no               | flow body        |
| `TsBuild`                | TsBuild           | build              | no        | yes              | flow body        |
| `Tsconfig`               | Tsconfig          | build, lint        | no        | yes              | flow body        |
| `Typecheck`              | Typecheck         | build              | no        | no               | flow body        |
| `TypedocDocs`            | TypedocDocs       | build              | no        | yes              | flow body        |
| `Vitest`                 | Vitest            | test               | no        | no               | flow body        |
| `VitestCoverage`         | VitestCoverage    | test               | no        | yes              | flow body        |
| `VitestWatch`            | VitestWatch       | run                | no        | no               | flow body        |

101 rules.
