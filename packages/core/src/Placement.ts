/**
 * Serializable placement annotations for flow graph values.
 *
 * Governing contract: `packages/core/docs/api.md`, published as
 * https://smithers.sh/api/core.
 *
 * @since 0.0.0
 */
import { Data } from "effect"

/**
 * Serializable host-selection details. These fields identify a host profile;
 * they never contain a host implementation, credentials, or other runtime
 * handle.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface Options {
  readonly image?: string | undefined
  readonly profile?: string | undefined
  readonly target?: string | undefined
}

/**
 * A serializable directive describing where a flow node should run.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type Placement = Data.TaggedEnum<{
  readonly "flows/core/Placement/Local": Readonly<Record<never, never>>
  readonly "flows/core/Placement/Client": Readonly<Record<never, never>>
  readonly "flows/core/Placement/Sandbox": Options
  readonly "flows/core/Placement/Remote": Options
}>

const constructors = Data.taggedEnum<Placement>()

/**
 * Creates a placement directive for the local process host.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const local = (): Placement => constructors["flows/core/Placement/Local"]()

/**
 * Creates a placement directive for the viewer's browser host.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const client = (): Placement => constructors["flows/core/Placement/Client"]()

/**
 * Creates a placement directive for an isolated sandbox host.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const sandbox = (options: Options = {}): Placement =>
  constructors["flows/core/Placement/Sandbox"]({ ...options })

/**
 * Creates a placement directive for a remote control-plane host.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const remote = (options: Options = {}): Placement => constructors["flows/core/Placement/Remote"]({ ...options })
