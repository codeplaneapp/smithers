# Vendored flows packages

Interim bridge. The flows library is not on the registry yet (`npm view
@smthrs/flows` returns E404, and `~/flows/flows/HUMAN-TASKS.md` H1 to H4 are
owner-only tasks that are not done), so the flows packages are committed here as
tarballs and exposed to Smithers source under `@flows/*` aliases.

```js
import { FlowEngine } from "@flows/engine";
import { Action, Flow, Interpreter } from "@flows/flow";
```

The bare `@smthrs/*` names keep meaning this workspace's own packages. Nine names
exist in both trees — `engine`, `gateway`, `memory`, `sandbox`, `scorers`,
`testing`, `time-travel`, `observability`, `cli` — and the whole migration rests
on the bare name resolving here and the flows copy only being reachable under an
alias. `.smithers/specs/flows-migration.md` section 0.1 is the naming decision.
`vendor/flows/resolution.test.mjs` asserts it.

## What is here

| Path | What it is |
| --- | --- |
| `*.tgz` | 29 tarballs: the dependency closure of `@smthrs/flows` plus the packages the migration names directly |
| `manifest.json` | name, version, filename, and sha256 of every tarball |
| `package.json` | generated workspace package that installs the tarballs under `@flows/*` |
| `README.md` | this file |

`node scripts/vendor-flows.mjs` regenerates all of it from a flows checkout.
`pnpm pack` is byte-deterministic, so a re-run against an unchanged checkout
produces no diff, and `node scripts/vendor-flows.mjs --check` fails if it would.

## How it resolves

Three pieces, and each one is load-bearing.

1. **`vendor/flows/package.json` declares the aliases**, as
   `"@flows/flow": "file:./smthrs-flow-0.1.0.tgz"`. `pnpm-workspace.yaml` lists
   `vendor/flows`; the root manifest's `workspaces` array, which is what bun
   reads, deliberately does not. See "Why bun does not see this" below.
2. **`.npmrc` public-hoists `@flows/*`** into the root `node_modules`, which is
   what makes the aliases importable from anywhere in the repository. Until the
   migration lanes declare `@flows/*` in their own manifests, that hoist is the
   only thing putting the aliases on the resolution path.
3. **`pnpm.overrides` in the root manifest redirects each vendored package at its
   exact version**, `"@smthrs/flow@0.1.0": "file:vendor/flows/…"`. The tarballs
   depend on each other by exact version, and none of those versions is on the
   registry, so without the overrides pnpm would 404 on the first transitive edge.

The override keys carry `@0.1.0` for a reason. A bare `"@smthrs/engine"` key
matches every range, including the `workspace:*` that this repository's own
packages depend on each other with, so it would silently redirect
`packages/engine` to the flows copy. Keying on the exact flows version leaves
every `workspace:*` edge alone.

## Why bun does not see this

bun has no version-scoped override. Measured against bun 1.4, with the tarballs
in place:

| Mechanism | Result |
| --- | --- |
| `overrides: { "@smthrs/engine@0.1.0": "file:…" }` | key ignored; `@smthrs/engine@0.1.0 failed to resolve` |
| `resolutions: { "@smthrs/engine@0.1.0": "file:…" }` | same |
| `overrides: { "@smthrs/engine-store": { "@smthrs/engine": "file:…" } }` | nested form ignored; registry 404 |
| `optionalDependencies` for the aliases | resolution still fatal |
| `overrides: { "@smthrs/engine": "file:…" }` | resolves, and takes over the workspace package: a sibling depending on `@smthrs/engine: workspace:*` gets the flows copy |

The last row is the one that matters. The only override form bun understands is
the one that breaks the property the migration depends on. So the flows edges
stay out of every bun-visible manifest, `bun install --frozen-lockfile --offline
--lockfile-only` keeps passing unchanged, and pnpm — the repository's package
manager — carries the vendored graph.

## Re-vendoring

```sh
node scripts/vendor-flows.mjs                       # default source: ../flows/flows
node scripts/vendor-flows.mjs ../../elsewhere/flows # or SMITHERS_FLOWS_REPO=…
node scripts/vendor-flows.mjs --check               # fail if a re-pack would change anything; writes nothing
node scripts/vendor-flows.mjs --list                # print the closure
```

`--check` packs into a temporary directory and compares, so a checkout that has
moved on reports the drift without rewriting `vendor/flows/`.

The flows checkout must already be built: the tarballs ship `dist/esm` and
`dist/cjs`, because the flows manifests point `exports` at TypeScript source that
only resolves inside the flows workspace, and the script rewrites `exports` from
`publishConfig.exports` when it stages each package. Nothing is written to the
flows checkout.

Adding a flows package the migration imports directly means adding it to
`rootPackages` in `scripts/vendor-flows.mjs`, re-running the script, and adding
the new override to `pnpm.overrides`. The test fails until the override is there.

## The swap, when the alpha publishes

This directory is temporary. Once flows publishes `0.1.0-alpha.N` under the
`alpha` dist-tag:

1. Change the `@flows/*` aliases from `file:` tarballs to registry version
   ranges: `"@flows/flow": "npm:@smthrs/flow@0.1.0-alpha.N"`. Move them from
   `vendor/flows/package.json` into the manifests of the packages that import
   them, since bun can resolve a registry alias and no override is involved.
2. Delete every `"@smthrs/*@0.1.0": "file:vendor/flows/…"` entry from
   `pnpm.overrides` in the root manifest. The published tarballs' transitive
   edges resolve from the registry on their own, isolated under `.pnpm`.
3. Delete `public-hoist-pattern[]=@flows/*` from `.npmrc`, and `vendor/flows`
   from `pnpm-workspace.yaml`.
4. Delete `vendor/flows/`, `scripts/vendor-flows.mjs`, the `!vendor/flows/*.tgz`
   line from `.gitignore`, and the `vendor:flows` and `check:vendored-flows`
   scripts.
5. Keep `resolution.test.mjs`, moving it out of `vendor/flows/`. Point its alias assertions at the
   published copies and keep the collision assertions exactly as they are — that
   is the property the migration rests on, and it outlives the vendoring.
6. Refresh `pnpm-lock.yaml` and `bun.lock` in the same commit.

`~/flows/flows/scripts/verify-alpha-install.mjs` is the gate on the flows side
that proves step 1 works from the registry, including the coexistence property.
