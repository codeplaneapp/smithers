# `@smthrs/jj`

This page is the public API reference for the `Jj` host service: version control as a capability. Permission enforcement is provided separately by `@smthrs/kernel`, whose `Jj` decorator wraps this contract.

The package depends on `effect` and `@smthrs/capability` — the interface names `Permission.PermissionError` in its error channel so the kernel decorator needs no second tag. `Jj` is still one of the five services in the closed host list `@smthrs/kernel` owns; the contract lives here so a consumer that only snapshots a working copy does not take a process spawner and an HTTP client with it.

## Contract

| Export | Kind | Notes |
| --- | --- | --- |
| `Jj` | interface + service tag | tag key `@smthrs/jj/Jj` |
| `ChangeId` | type | the durable handle a run uses to name workspace state |
| `snapshot`, `restore`, `diff`, `workspaceAdd`, `workspaceForget`, `status` | methods | every one fails with `JjError` |
| `JjError` | class | tagged `@smthrs/jj/JjError`, carrying `code`, `module`, `method`, `message`, the `command` that produced it, and an optional `cause` holding the underlying host failure |
| `JjErrorCode` | const + type | `not_installed`, `conflict`, `invalid_ref`, `unknown` |
| `jjError` | constructor | builds a `JjError` from a code plus context |
| `make`, `makeNoop`, `layerNoop` | constructors and layer | `makeNoop` fails every method with `not_installed` until overridden |

`snapshot` describes the current change, reads its id, and opens a fresh one — the id returned is the state a later `restore` goes back to.

## Implementations

Implementations are **not** root exports. The root is the portable contract and bundles for the browser; each implementation is imported from its own subpath.

| Import | Layer |
| --- | --- |
| `@smthrs/jj/node/NodeJj` | `layer` spawning the `jj` CLI with argv, never a shell string |
| `@smthrs/jj/bun/BunJj` | `layer` — Bun implements the same child-process API, so this is `NodeJj.layer` |
| `@smthrs/jj/browser/BrowserJj` | `layer({ fs, wasm })` — jj-lib compiled to `wasm32-wasip1`, run over an injected virtual filesystem; `layerUnsupported` is the fallback where no module ships, reporting `not_installed` |

```ts
import { Jj } from "@smthrs/jj"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
```

`NodeJj` deliberately spawns its own children rather than going through `ChildProcessSpawner`: jj invocations are argv arrays with no shell interpretation, and the host must be able to checkpoint work even where process spawning is unavailable, sandboxed, or gated behind a `proc:spawn` grant the user has not given. Errors are classified from jj's own stderr vocabulary onto the stable codes, the way `NodeFileSystem` classifies errno.

jj is a native binary, but jj-lib compiles to `wasm32-wasip1`. `BrowserJj.layer({ fs, wasm })` runs that module — shipped as `packages/jj/wasm/flows_jj.wasm` — over an injected virtual filesystem, through a hand-written WASI preview1 shim in this package; the mount and the compiled module are arguments, not dependencies, so the library never picks a storage backend for its host. `BrowserJj.layerUnsupported` stays exported for a host that ships no module and reports `not_installed` — the same code the Node layer uses when the binary is absent, so a caller needs no browser-specific branch. It is a ticket, not a silent exception; see `Concepts/Browser jj` in the spec vault.

## Durable identity

The tag key `@smthrs/jj/Jj` and the error `_tag` `@smthrs/jj/JjError` are durable identity: step keys digest the resolved service set, and `JjError` round-trips through the journal, so renaming either invalidates recorded runs. `packages/jj/test/index.test.ts` pins both. See [step keys](../concepts/step-keys.md).

## Browser support

`@smthrs/jj` and `@smthrs/jj/browser/BrowserJj` are gated as browser entry points by `scripts/browser-check.mjs` (`pnpm run browser`, and one CI step). The same gate asserts `@smthrs/jj/node/NodeJj` and `@smthrs/jj/bun/BunJj` still do *not* bundle, and that the reason is `node:child_process`.

See [Hosts and capabilities](../concepts/hosts-and-capabilities.md), the [`@smthrs/kernel` reference](kernel.md), and [time travel](../concepts/time-travel.md), which uses `Jj` for workspace snapshot and restore.
