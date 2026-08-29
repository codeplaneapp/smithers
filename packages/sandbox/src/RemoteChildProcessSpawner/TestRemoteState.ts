/**
 * Defines observations recorded by the remote test provider.
 *
 * @since 0.1.0
 */

/**
 * Mutable observations exposed by the deterministic test double.
 *
 * @category models
 * @since 0.1.0
 */
export interface TestRemoteState {
  readonly openedSessions: Array<string>
  readonly commands: Array<string>
  cancellations: number
}
