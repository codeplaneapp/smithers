---
title: "@smthrs/build"
description: "Bazel-style TypeScript workflow orchestration with explicit pnpm installation"
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/build/docs/README.md"
---

smithers build is a Bazel-style build orchestrator for TypeScript workspaces. `PACKAGE.ts`
files are plain TypeScript modules whose named exports are targets. Target calls
return flows with planner metadata. Direct imports between `PACKAGE.ts` files form
dependency edges.

These pages describe what the code does today. Behavior that is declared but not
wired is marked as such on the page that covers it.

## About

| Page                                                      | Description                                                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [What is smithers build](/about/what-is-smithers-build/) | The everything-is-a-flow model, and how smithers build compares to Bazel, Turborepo, and nx. |
| [FAQ](/about/faq/)                                       | Short answers to the questions the design raises.                                            |

## Getting started

| Page                                          | Description                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| [Install](/getting-started/install/)         | Wire `@smthrs/targets` and the CLI into an existing pnpm workspace.          |
| [First build](/getting-started/first-build/) | Write a root `PACKAGE.ts` and one package `PACKAGE.ts`, then run every verb. |

## Workspace

| Page                                                       | Description                                                                                                            |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [Structure](/workspace/structure/)                        | Discovery, `PACKAGE.ts` placement, package boundaries, default-target synthesis.                                       |
| [Writing BUILD files](/workspace/writing-build-files/)    | Targets as named exports, target calls, import edges, macros.                                                          |
| [Configuration](/workspace/configuration/)                | The `Workspace` declaration, `cacheDirectory`, `gitignored`, `--cache-dir`.                                            |
| [Running targets](/workspace/running-targets/)            | `install`, target verbs including `run` and `docs`, `ci`, and what actually executes.                                  |
| [Querying](/workspace/querying/)                          | `query`, `deps()`, and `graph`.                                                                                        |
| [Caching](/workspace/caching/)                            | Content keys, the result cache, and what re-keys a target.                                                             |
| [Remote caching](/workspace/remote-caching/)              | The HTTP read-through cache, the hosted and self-hosted `/ac` and `/cas` services, and the current engine boundary.    |
| [The jjhub-hosted cache](/workspace/jjhub-cache/)         | Zero-config discovery from the jjhub remote, committed public read tokens, and publishing from CI and agent computers. |
| [Smithers repo adoption](/workspace/flows-repo-adoption/) | What the Smithers monorepo runs through smithers build today, the shadow CI lane, and the promotion criteria.          |

## Concepts

| Page                                                         | Description                                                                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| [Labels](/concepts/labels/)                                 | The `//pkg:target` grammar, package defaults, and `//...` patterns.                                                               |
| [Targets and targets](/concepts/targets/)                   | A target is a flow with planner metadata.                                                                                         |
| [Inputs](/concepts/inputs/)                                 | `file()`, `glob()`, `gitDiff()`, and when they are digested.                                                                      |
| [Dependencies](/concepts/dependencies/)                     | Import edges, `deps` attributes, and transitive planning.                                                                         |
| [Actions and boundaries](/concepts/actions-and-boundaries/) | Sealed actions, `TreeArtifact` writes, host state, and hermeticity.                                                               |
| [Install](/concepts/install/)                               | The measure round, fetch key material, the fetch/link split, and manager-as-layer.                                                |
| [Environments](/concepts/environments/)                     | The declared Nix closure tools resolve from, its key layer, and what it makes cacheable.                                          |
| [Ownership](/concepts/ownership/)                           | `owners` on a package: inheritance, per-file rules, agent policy, upstream claims, and the generated CODEOWNERS and OWNERS files. |

## Extending

| Page                                            | Description                                                                        |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Writing targets](/extending/writing-targets/) | `Target.make`: the attrs schema, the plan-time implementation, and typed failures. |
| [Writing macros](/extending/writing-macros/)   | `StandardPackage` as the worked example.                                           |
| [Default targets](/extending/default-rules/)   | `PackageDefaults`, `directories`, `marker`, `unless`, and `macro`.                 |

## Reference

| Page                                          | Description                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| [CLI](/reference/cli/)                       | Every verb, flag, output shape, and exit code.                                         |
| [Terminal output](/reference/cli-output/)    | The `--ui` renderers, what a person sees on a terminal, and the prior art they follow. |
| [Workspace](/reference/config/)              | The `Workspace` declaration and its exact validation targets.                          |
| [Target catalog](/reference/targets/) | One page per target, with attribute tables and execution status.                       |
