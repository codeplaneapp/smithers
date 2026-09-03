# @smthrs/build

`@smthrs/build` is a Bazel-style build orchestrator for TypeScript
workspaces.
`PACKAGE.ts` files are ordinary TypeScript modules whose named exports are
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

Installation is one round of three actions:

1. `measure` records the content an install is keyed on: the lockfile digest
   and the credential-free project `.npmrc` digest. The manager version and the
   host platform are not content; they come from the `PackageManager` and
   `Runtime` services, which hold the host to what the workspace declared.
2. A manager-specific `fetch` populates `.flows/store/<manager>`. The manager
   is a plan-time declaration from PACKAGE.ts, so the body selects exactly one
   fetch without a second round.
3. `link` reconciles `node_modules` from that store.

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
smithers-build install --workspace /path/to/workspace
```

The install store is fixed at `.flows/store/pnpm`, so `install` requires the
default `.flows` cache-directory configuration. Other CLI verbs may use a
custom workspace-relative cache directory.

## Cache directory

The root `PACKAGE.ts` may declare where target results and rule scratch files
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

`tokenEnv` defaults to `SMITHERS_CACHE_TOKEN`. A deployment that separates
reading from publishing declares the split form instead, and the two values
arrive through `SMITHERS_CACHE_READ_TOKEN` and `SMITHERS_CACHE_WRITE_TOKEN`:

```ts
export const remoteCache = Smithers.RemoteCache.make({
  endpoint: "https://build.smithers.sh",
  read: Smithers.Secret("SMITHERS_CACHE_READ_TOKEN"),
  write: Smithers.Secret("SMITHERS_CACHE_WRITE_TOKEN")
})
```

A bearer value must arrive through an environment variable and never enters
`PACKAGE.ts`, a target key, or a stored entry. `SMITHERS_CACHE_URL` can override
the declared HTTPS endpoint for one process. See
[remote caching](docs/workspace/remote-caching.md) for which job gets which
credential, and `infra/CACHE-TRUST.md` for the trust model the split exists to
enforce.

A local hit avoids HTTP. A remote hit hydrates the local cache. Remote failures
warn once and degrade to local-only; a first-writer conflict warns without
failing the run. Bodies, keys, JSON structure, timeouts, and stream chunk counts
are bounded, and corrupt or misfiled entries are misses rather than results.

Both deployments, the hosted Cloudflare Worker under `infra/` and the
self-hosted container under `terraform/`, serve the same routes, the same
bounds, and the same read/write credential split. They are two implementations
of it rather than one shared one, so a change to either belongs in both:

- `/ac/{keyDigest}` for action-cache documents;
- `/cas/{sha256}` for content-addressed artifacts;
- `/cas/findMissing` for batched artifact probes;
- public `/healthz` readiness checks that reveal no cache state.

The smithers-build CLI currently uses `/ac` directly for target success values. It
does not compose the Smithers engine's remote step-cache and artifact layers.
See [remote caching](docs/workspace/remote-caching.md) for that distinction.

## Development

Use Node.js 22.19 or newer. The repository's supported gates are:

From the Smithers repository root, run `pnpm check`, `pnpm lint`, `pnpm test`,
`pnpm circular`, and `pnpm browser`. To work on only these packages, use pnpm's
`--filter` option with `@smthrs/build`, `@smthrs/targets`, or
`@smthrs/build-cli`.
