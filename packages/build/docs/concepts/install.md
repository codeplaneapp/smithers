# Install

`smithers-build` expresses dependency installation as one flow with one round and
three actions: measure, fetch, and link. A workspace declares pnpm or Bun.
Only pnpm performs work today; the Bun layer resolves the service and refuses
every operation with a typed `unsupported` error.

`node_modules` is a target. A BUILD.ts file declares the toolchain once and
asks the `Install` target for the tree:

```ts
import { Smithers } from "@smthrs/targets"

export const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })
export const nodeModules = Smithers.Install({ packageManager })
```

The CLI also runs the flow directly:

```sh
smithers-build install --workspace /absolute/or/relative/workspace
```

The library layer requires an absolute project root and the declared version.
The platform is not a layer option: it belongs to the `Runtime` service, which
the package-manager layer takes as a dependency.

```ts
PackageManager.layerPnpm({
  projectRoot: "/workspace",
  requirement: "11.21.0"
}).pipe(
  Layer.provideMerge(Runtime.layerNode({
    requirement: ">=22.19.0",
    platform: { os: "linux", arch: "x64", libc: "glibc" }
  }))
)
```

The complete embedding also supplies `Install.layer` from
`@smthrs/build`, an interpreter
registration for `Install.Install`, a flow runtime, and Node filesystem,
process, and crypto services. The CLI composition in
`packages/build-cli/src/engine.ts` is the reference.

## One round

The flow payload is `{ manager }`, the manager the workspace declared.

```text
Measure.call({})
  -> Fetch[manager].call({ content })
    -> Link.call({ content, store })
```

`maxRounds` is one.

The flow used to trampoline. The package-manager implementation is a runtime
layer, so a pure body could not branch on it, and the first round existed to
measure which manager was wired before a second round could select a
manager-specific fetch. The manager is now a plan-time declaration from
BUILD.ts, so one body selects one fetch action with one exact lockfile
declaration, and measure feeds it as an ordinary settled upstream reference.

## Measure

`Measure` digests the manager lockfile and the project `.npmrc` when present.
That is all it does.

```ts
Content = {
  lockfile: { path, digest }
  npmrc: { path, digest } | null
}
```

It used to report an `Environment` struct carrying the manager name, the
measured manager version, and the host platform as well. Those three were never
content: they are the identity of two host services, and they now come from
those services.

- Which manager, and which version it must be, is the `PackageManager` service.
  The workspace declares the version and `PackageManager.Service.verify` holds
  the host to it.
- The platform is the `Runtime` service. It describes the machine, so it is not
  a field passed between steps.

The action uses an `expected` boundary and is never answered from the cross-run
engine cache: a restored measurement would describe another machine's checkout.

`.npmrc` is limited to 256 KiB, `package.json` to 4 MiB, and lockfiles to
64 MiB. Reads use stable regular-file descriptors, exact UTF-8, and
canonical-path checks inside the project root.

## Fetch identity

The fetch payload includes:

1. the lockfile path and SHA-256 digest;
2. the project `.npmrc` digest or `null`.

The scheduler also folds declaration identity, layers, capabilities, effects,
and settled dependencies into its step key. The manager name and version reach
the key through the layer identity the planner records for the target, which is
derived from the BUILD.ts declaration. The absolute project root and store path
are host placement, not content identity.

Before fetch starts, the implementation checks three things against each other:
the manager the workspace declared, the manager the composition provided, and
the versions the host actually has. A mismatch fails with
`environment_mismatch` before anything is written. This replaces the old
cross-round recheck, which could only compare one measurement of a host against
an earlier measurement of the same host.

Fetch returns a `StoreManifest`:

```ts
{
  manager, managerVersion, platform, digest
}
```

Its digest is SHA-256 over a versioned canonical tuple of the measured
environment. It describes what populated the store; it is not the store bytes.

## Why fetch is not cache-admissible

Fetch declares `.flows/store/<manager>` as a `TreeArtifact`, but its boundary
mode is `expected`, not `hard`. The current manager process runs against an
absolute workspace root and opens the lockfile and `.npmrc` itself. The parent
can compare those files before and after execution but cannot freeze their
paths across the child's opens. The unsandboxed observer also cannot attest
that no undeclared path was read or written.

Consequently no fetch result or store tree is replayed from a cross-run engine
cache today. A sandbox lane that supplies hermetic-read and whole-tree evidence
is required before changing this policy.

## Link

Link verifies the measured environment and `StoreManifest`, digests the root
`package.json`, runs the manager's link operation, digests the manager's own
tree evidence, and returns:

```ts
LinkManifest = { store: Digest, manifest: Digest, linked: true }
```

Link always reconciles `node_modules`. A hidden lockfile or modules manifest
describes the graph a manager intended to create, but cannot prove that every
package file is still present and unmodified. There is no
`node_modules/.flows-link.json` freshness shortcut.

The action uses an `expected` boundary and declares no materialized output.
`node_modules` is a host-local graph of links into the store and is never
restored from another machine.

## Manager support

| Manager | Status      | Behavior                                                                             |
| ------- | ----------- | ------------------------------------------------------------------------------------ |
| pnpm    | Implemented | Frozen fetch into `.flows/store/pnpm`, then frozen offline link with scripts ignored |
| npm     | Unsupported | No verified fetch-only verb satisfying the declared lockfile boundary                |
| Bun     | Unsupported | No documented fetch-only and offline-link pair satisfying the contract               |
| Yarn    | Unsupported | Named for future compatibility; no implementation is wired                           |

The pnpm commands are:

```text
pnpm fetch --frozen-lockfile --ignore-scripts --reporter=append-only \
  --store-dir <projectRoot>/.flows/store/pnpm

pnpm install --offline --frozen-lockfile --ignore-scripts \
  --reporter=append-only --store-dir <projectRoot>/.flows/store/pnpm
```

`layerBun` and `layerNoop("bun", options, platform)` still provide the service
shape. Version, fetch, link, and manifest operations fail with
`PackageManagerError { code: "unsupported" }`, making unsupported selection
deterministic rather than a missing-layer defect.

## Environment and credentials

Package-manager children use `extendEnv: false`. They receive deterministic
locale/color settings, selected bootstrap and network variables, and variables
explicitly referenced as `${NAME}` in the project `.npmrc`.

Literal auth tokens, passwords, key files, and certificate fields in `.npmrc`
are refused. Placeholders that reference process-control names such as
`NODE_*`, `NPM_CONFIG_*`, `PNPM_*`, `BUN_*`, loader variables, or shell startup
variables are also refused. User and global npm configuration paths are forced
to the null device.

Remote-cache endpoint and token variables are removed before the install layer
receives its environment snapshot.

## Store placement

Manager stores are fixed below `.flows/store/<manager>`. Discovery and glob
expansion always exclude that tree.

Because the install action declaration contains that fixed path, the direct
`install` command rejects a custom `cacheDirectory`. Other target verbs may use
one. Making install placement configurable requires changing the declared
boundary and host-state substitution together; silently writing one path while
declaring another is not allowed.

## Lifecycle scripts

Every supported command passes `--ignore-scripts`. Arbitrary package lifecycle
code needs a separate non-sealed execution model and is not part of this flow.

## Next

- [Actions and boundaries](actions-and-boundaries.md)
- [Install](../reference/targets/install.md)
- [PnpmWorkspace](../reference/targets/pnpm-workspace.md)
- [Remote caching](../workspace/remote-caching.md)
