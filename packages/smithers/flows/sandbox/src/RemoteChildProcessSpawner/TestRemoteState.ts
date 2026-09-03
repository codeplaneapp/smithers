/**
 * Defines observations recorded by the remote test provider.
 *
 * @since 0.1.0
 */

/**
 * One signal the scripted provider was asked to deliver.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestRemoteKill {
  readonly command: string
  readonly signal: string
}

/**
 * Mutable observations exposed by the deterministic test double.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestRemoteState {
  readonly openedSessions: Array<string>
  readonly commands: Array<string>
  /** The standard input each spawned command received, by spawn order. */
  readonly inputs: Array<Uint8Array | undefined>
  /** Every signal the adapter asked the provider to deliver, in order. */
  readonly kills: Array<TestRemoteKill>
  cancellations: number
}
