/**
 * @since 0.1.0
 *
 * `@smthrs/sandbox` — remote process execution and sandbox liveness.
 *
 * Modules are re-exported as namespaces, the way `effect`'s own index does it,
 * so each keeps its `make` / `makeNoop` / `layerNoop` trio without colliding
 * with its neighbour.
 *
 * The package is **platform-neutral and browser-bundleable**: it adapts a
 * provider a caller hands it onto Effect's `ChildProcessSpawner` contract and
 * owns no host access of its own. `scripts/browser-check.mjs` at the repository
 * root pins that property.
 *
 * ```ts
 * import { RemoteChildProcessSpawner, SandboxHealth } from "@smthrs/sandbox"
 * ```
 */

/** Remote implementation of Effect's `ChildProcessSpawner`. */
export * as RemoteChildProcessSpawner from "./RemoteChildProcessSpawner/index.ts"

/** The conformance suite a provider implementation must pass. */
export * as ProviderConformance from "./ProviderConformance/index.ts"

/** The provisioned-machine contract and its projections. */
export * as Sandbox from "./Sandbox/index.ts"

/** The conformance suite a sandbox session provider must pass. */
export * as SandboxConformance from "./SandboxConformance/index.ts"

/** The scratch-directory sandbox provider. */
export * as DirectorySandbox from "./DirectorySandbox/index.ts"

/** The container-lifecycle sandbox provider. */
export * as ContainerSandbox from "./ContainerSandbox/index.ts"

/** Sandbox health-check contracts. */
export * as SandboxHealth from "./SandboxHealth/index.ts"

/** Heartbeat supervision over a remote sandbox session. */
export * as SandboxSupervision from "./SandboxSupervision/index.ts"
