---
title: "Changesets"
description: "Checks or applies Changesets versioning and declares release publication."
---

`Smithers.Changesets` is a namespace with `Version` and `Publish` targets.

## Changesets.Version

Runs `changeset version` through the workspace's declared Node package manager.
With pnpm, the command is:

```text
pnpm exec changeset version
```

| Name      | Type              | Default  | Description                                                   |
| --------- | ----------------- | -------- | ------------------------------------------------------------- |
| `config`  | `Input.File`      | required | Changesets configuration.                                     |
| `data`    | `Attr.Data`       | optional | Additional declared inputs and target dependencies.            |
| `changes` | `Array<string>`   | required | Allowed write patterns for manifests, changelogs, and changesets. |

|           |                                                                                       |
| --------- | ------------------------------------------------------------------------------------- |
| Kinds     | `run`, `lint`                                                                         |
| Cacheable | Check mode only                                                                       |
| Executes  | Yes. `run` applies versioning; `lint` checks for drift by running in a scratch copy.    |

`ci` includes the `lint` check. An explicit `--write` or `--fix` requests write
mode. Changes must stay within the declared `changes` patterns. There is no
`dryRun` attribute on this target; check mode controls whether changes reach
the working tree. `--plan` never executes the command.

## Changesets.Publish

Declares publication of a release train after packing and validation gates.

| Name         | Type                  | Default  | Description                                           |
| ------------ | --------------------- | -------- | ----------------------------------------------------- |
| `config`     | `Input.File`          | required | Changesets configuration.                             |
| `pack`       | `Target.Target`       | required | Package artifact target.                              |
| `gates`      | `Attr.Gates`          | required | Validation targets.                                   |
| `provenance` | `boolean`             | optional | Provenance policy.                                    |
| `secrets`    | `Attr.Secrets`        | optional | Declared credentials; the outward gate requires `NPM_TOKEN`. |
| `sandbox`    | `Attr.Sandbox`        | optional | Sandbox policy.                                       |
| `approval`   | `Attr.Approval`       | optional | `required` needs an approval the package runner cannot grant. |

|           |                                                                                          |
| --------- | ---------------------------------------------------------------------------------------- |
| Kinds     | `run`                                                                                    |
| Cacheable | Never                                                                                    |
| Executes  | Refuses at the outward-action gate. The package runner does not implement this publication. |

The gate checks declared credentials and required approval. Even when those
checks pass, the current outward action reports `NotImplemented`.

## Irreversible execution

The `@smthrs/targets/Changesets` module exports `ExecIrreversible` and
`ExecIrreversibleLive`. The CLI supplies that layer. It is used by
[NpmPublish](npm-publish.md) and [JsrPublish](jsr-publish.md), which execute
through the action runtime and can publish. Each has a `run` verb gate that
rejects other verbs even through dependencies, and a resolved `dryRun`
attribute that defaults to `true` and appends `--dry-run`. Setting
`dryRun: false` enables real publication.

The irreversible tier prevents blind retries, verification, replay, and cache
population from executing the action. It does not block an ordinary CLI run.
The `Changesets.Publish` refusal is specific to its outward-action path.

## See also

- [NpmPublish](npm-publish.md)
- [JsrPublish](jsr-publish.md)
- [Actions and boundaries](../../concepts/actions-and-boundaries.md)
