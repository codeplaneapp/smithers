/**
 * Defines the provider-neutral remote execution contract.
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import type { Scope } from "effect/Scope"
import type * as Stream from "effect/Stream"
import type { ProviderError } from "./ProviderError.ts"

/**
 * A started remote process, in the same three pieces a local child process
 * exposes.
 *
 * @category models
 * @since 0.1.0
 */
export interface RemoteProcess {
  readonly stdout: Stream.Stream<Uint8Array, ProviderError>
  readonly stderr: Stream.Stream<Uint8Array, ProviderError>
  readonly exitCode: Effect.Effect<number, ProviderError>
}

/**
 * Options a rendered command carries to the remote side.
 *
 * @category models
 * @since 0.1.0
 */
export interface RemoteOptions {
  readonly cwd?: string | undefined
  readonly env?: Record<string, string | undefined> | undefined
}

/**
 * A configured remote provider.
 *
 * `session` is the stable provider-neutral session key. `open(session)` must
 * acquire the remote session and register its cancellation or close operation
 * as a scope finalizer. `spawn` starts one command in that opened session; its
 * scope is the process's lifetime.
 *
 * @category services
 * @since 0.1.0
 */
export interface Provider {
  readonly session: string
  readonly open: (session: string) => Effect.Effect<void, ProviderError, Scope>
  readonly spawn: (
    command: string,
    options: RemoteOptions
  ) => Effect.Effect<RemoteProcess, ProviderError, Scope>
}

/**
 * Remote provider service tag.
 *
 * Provider packages may expose this tag in addition to passing the configured
 * service directly to `layer`.
 *
 * @category services
 * @since 0.1.0
 */
export const Provider: Context.Service<Provider, Provider> = Context.Service(
  "@smthrs/sandbox/RemoteChildProcessSpawner/Provider"
)
