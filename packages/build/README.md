# @smthrs/build

`@smthrs/build` is a Bazel-style build orchestrator for TypeScript
workspaces.
`BUILD.ts` files are ordinary TypeScript modules whose named exports are
targets. Rules declare inputs, outputs, capabilities, cacheability, and the
flow that implements the target; imports between build files form dependency
edges.

The complete user documentation lives in [`docs/`](docs/README.md). It covers
workspace authoring, every CLI verb, the rule catalog, caching, and the install
flow.

## Current execution model

The CLI discovers and digests declared inputs before execution, computes a
content key, runs dependency-first with bounded parallelism, and keeps going
outside a failed target's dependent cone. Successful cacheable results are
stored as bounded JSON under `<cacheDirectory>/cache`; a configured HTTPS
remote adds a read-through `/ac` tier.

This is not a sandbox. Tools run directly in the workspace, so an effects
declaration is analysis and cache metadata rather than proof that the process
read and wrote only those paths. The executor revalidates declared inputs
before cache admission and after execution, and verifies declared outputs
before reporting or caching success. It does not claim Bazel-style hermeticity
without the sandbox evidence needed to support that claim.

## Dependency installation

Installation is a two-round flow:

1. `measure` records the selected manager's exact version, platform, lockfile
   digest, and credential-free project `.npmrc` digest.
2. A manager-specific `fetch` populates `.flows/store/<manager>`, then `link`
   reconciles `node_modules` from that store.

All three actions currently use an `expected` filesystem boundary. None is
admitted to a cross-run engine cache: the absolute-root package-manager process
cannot freeze its lockfile and `.npmrc` across the child's own opens, and the
linked tree is host-local. `link` always runs; manager metadata cannot prove
that every installed package file is still present and intact.

Only pnpm has a live implementation. It runs:

```text
pnpm fetch --frozen-lockfile --ignore-scripts --reporter=append-only \
  --store-dir <workspace>/.flows/store/pnpm

pnpm install --offline --frozen-lockfile --ignore-scripts \
  --reporter=append-only --store-dir <workspace>/.flows/store/pnpm
```

The Bun layer is an explicit typed refusal. It remains in the service schema
so unsupported selection fails with `code: "unsupported"` instead of silently
approximating a verified fetch.

Run the supported flow with:

```sh
smthrs install --workspace /path/to/workspace
```

The install store is fixed at `.flows/store/pnpm`, so `install` requires the
default `.flows` cache-directory configuration. Other CLI verbs may use a
custom workspace-relative cache directory.

## Cache directory

The root `BUILD.ts` may declare where target results and rule scratch files
live:

```ts
import { Smithers } from "@smthrs/targets"

export const config = Smithers.Workspace({ cacheDirectory: ".flows", gitignored: true })
```

Precedence is `--cache-dir`, then the declaration, then `.flows`. The value is
bounded, control-free, workspace-relative text; absolute paths, parent
traversal, oversized segments, and malformed Unicode are refused. When
`gitignored` is true, the CLI updates the root `.gitignore` with a bounded,
descriptor-stable, atomic read-modify-write.

The resolved directory is host state and never enters a target key. Discovery
and globs exclude it, as well as the fixed `.flows/store` install tree.

## Remote result cache

Declare an endpoint without embedding a credential:

```ts
import { Smithers } from "@smthrs/targets"

export const remoteCache = Smithers.RemoteCache.make({
  endpoint: "https://build.smithers.sh"
})
```

`tokenEnv` defaults to `SMITHERS_CACHE_TOKEN`. The bearer value must arrive
through that environment variable and never enters `BUILD.ts`, a target key,
or a stored entry. `SMITHERS_CACHE_URL` can override the declared HTTPS endpoint
for one process.

A local hit avoids HTTP. A remote hit hydrates the local cache. Remote failures
warn once and degrade to local-only; a first-writer conflict warns without
failing the run. Bodies, keys, JSON structure, timeouts, and stream chunk counts
are bounded, and corrupt or misfiled entries are misses rather than results.

The shared hosted and self-hosted protocol exposes:

- `/ac/{keyDigest}` for action-cache documents;
- `/cas/{sha256}` for content-addressed artifacts;
- `/cas/findMissing` for batched artifact probes;
- public `/healthz` readiness checks that reveal no cache state.

The smthrs CLI currently uses `/ac` directly for target success values. It
does not compose the flows engine's remote step-cache and artifact layers.
See [remote caching](docs/workspace/remote-caching.md) for that distinction.

## Development

Use Node.js 22.19 or newer. The repository's supported gates are:

From the flows repository root, run `pnpm check`, `pnpm lint`, `pnpm test`,
`pnpm circular`, and `pnpm browser`. To work on only these packages, use pnpm's
`--filter` option with `@smthrs/build`, `@smthrs/targets`, or
`@smthrs/build-cli`.
