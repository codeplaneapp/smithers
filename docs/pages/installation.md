---
description: "Install the 1.0.0-rc.0 packages and the smithers command, with the exact Effect pin and the release-candidate warning."
---

# Installation

Smithers 1.0.0-rc.0 is a release candidate. It is a source migration, not a
compatible upgrade from Smithers 0.x: there is no JSX workflow API, no React
reconciler, and no way to load or resume a 0.x run database. Read
[migrating from 0.x](/migration/1.0) before you install it over an existing
project.

## Requirements

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | 22.19.0 or later | The durable engine opens SQLite through `node:sqlite`. |
| Effect | exactly `4.0.0-rc.108` | Two Effect instances in one process are not interoperable. |
| Bun | 1.3.0 or later, optional | Runs the applications and the non-durable packages. Opening a durable database under Bun fails with `unsupported_runtime`. |
| `jj` | on `PATH`, optional | Only the Jujutsu host service needs it. `smithers doctor` reports it as missing. |

Windows is unsupported. macOS and Linux x64 are supported.

## Install the libraries

Release candidates publish to the `next` dist-tag. The `@next` suffix is required:
`latest` still resolves the Smithers 0.x line.

:::code-group

```bash [pnpm]
pnpm add @smthrs/flow@next @smthrs/engine@next effect@4.0.0-rc.108 @effect/platform-node@4.0.0-rc.108 @effect/platform-node-shared@4.0.0-rc.108
```

```bash [npm]
npm install @smthrs/flow@next @smthrs/engine@next effect@4.0.0-rc.108 @effect/platform-node@4.0.0-rc.108 @effect/platform-node-shared@4.0.0-rc.108
```

```bash [bun]
bun add @smthrs/flow@next @smthrs/engine@next effect@4.0.0-rc.108 @effect/platform-node@4.0.0-rc.108 @effect/platform-node-shared@4.0.0-rc.108
```

:::

`@smthrs/flow` carries the authoring model and `@smthrs/engine` runs it in
memory. Add `@smthrs/flows@next` when you want the curated aggregate and the
`NodeRuntime` production composition instead of assembling layers by hand.
[Package selection](/package-structure) lists what each package is for.

Pin Effect to exactly `4.0.0-rc.108`. Every published Smithers package declares
that exact version for `effect` and for the `@effect/*` packages that follow
Effect's own version line. A project that resolves two Effect versions is
unsupported, because schema internals are not interoperable between instances.

## Why the install line names `@effect/platform-node-shared`

`@effect/platform-node@4.0.0-rc.108` asks for `@effect/platform-node-shared`
`^4.0.0-rc.108`, the registry answers `4.0.0-rc.112`, and that version's own
peer range demands Effect `4.0.0-rc.112`. Naming the package in your own
dependencies settles the range: npm 11, Bun 1.4, and pnpm 11 each resolve one
copy, at `4.0.0-rc.108`. A dependency cannot do this for you, because a
manifest does not rewrite the range a sibling declares, and the published
Smithers packages that depend on `@effect/platform-node` already pin the shared
package exactly without changing the outcome.

If you installed without it, `npm ls --all` exits 1 with
`invalid: "^4.0.0-rc.112"`. Bare `npm ls` prints direct dependencies only, so it
exits 0 with the drifted copy nested below that depth. Adding the package
repairs the tree in place, with no reinstall:

```bash
npm install --save-exact @effect/platform-node-shared@4.0.0-rc.108
```

### The overrides alternative

An `overrides` pin reaches the same tree and is the heavier route.

:::code-group

```json [package.json (npm, bun)]
{
  "overrides": {
    "@effect/platform-node-shared": "4.0.0-rc.108"
  }
}
```

```yaml [pnpm-workspace.yaml (pnpm)]
overrides:
  "@effect/platform-node-shared": 4.0.0-rc.108
```

:::

pnpm 11 no longer reads a `pnpm` field from `package.json`, so a
`pnpm.overrides` block there is ignored with a warning and the drifted version
is installed anyway. npm does not reconcile a tree that is already on disk when
`overrides` changes: with `node_modules` and `package-lock.json` present it
answers `up to date` and leaves the drifted copy nested. Add the pin before the
first install, or delete `node_modules` and the lockfile (`package-lock.json` or
`bun.lock`) and install again.

## Install the command

```bash
npm install --global @smthrs/cli@next
```

The package installs one binary, `smithers`. Its shim starts with
`#!/usr/bin/env node`, so every installation path runs it under Node even when
Bun invokes it. Running the CLI with `bun --bun` is unsupported.

Run it without installing:

:::code-group

```bash [npx]
npx @smthrs/cli@next smithers ls
```

```bash [bun]
bun x --package @smthrs/cli@next smithers ls
```

:::

Check the installation:

```bash
smithers doctor
```

`doctor` reports flow discovery warnings, the database paths and their
migration state, the Node version, whether `jj` is on `PATH`, which provider
keys are present, and whether it found Smithers 0.x state in the directory.

## Start a project

```bash
smithers init my-project
```

`init` scaffolds `flows/my-project/flow.mdx` and adds `.flows/` to
`.gitignore`. Flows live in `flows/**` as `flow.ts`, `flow.mdx`, or `SKILL.md`;
run state lives in `.flows/`. `smithers init --global` is not supported and
exits 1: seats resolve from environment keys, not from a global pack.

The scaffold carries a `model:` line, because `smithers up` cannot run a prompt
flow that declares no seat. `init` picks it from the provider keys below, in the
order `doctor` reports them, and says in the file which key it used. With no key
set it writes the `anthropic:claude-sonnet-4-5` seat, and `smithers up` then
refuses by naming `ANTHROPIC_API_KEY` instead of starting a run nothing will
drive. Edit the line to run somewhere else.

[Writing a flow](/guides/writing-a-flow) is the next page.

## Provider keys

The model seats read `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and
`OPENROUTER_API_KEY` from the environment. `SMITHERS_OPENAI_AUTH=chatgpt`
selects ChatGPT authentication for the OpenAI seat. Smithers 1.0.0-rc.0 ships no
multi-account seat pool; one key per provider is the whole configuration.

## What the release candidate does not include

A candidate is not a preview of missing work: the exclusions below are enforced,
not pending.

- SQLite only. PostgreSQL and PGlite exit with `unsupported_database`. See
  [databases](/databases).
- No 0.x compatibility of any kind. See [migrating from 0.x](/migration/1.0).
- Time travel is a library API, not a command. See
  [time travel](/concepts/time-travel).
- The full list is in [known limitations](/release/known-limitations), and what
  is supported is in the [rc.0 support matrix](/release/support-matrix).
