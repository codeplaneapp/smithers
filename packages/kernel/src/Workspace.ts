/**
 * The workspace root used to make filesystem capability resources stable.
 *
 * It lives beside the closed host list rather than in a platform package: a
 * workspace root is a policy decision the kernel needs before it can name a
 * filesystem capability, not something a platform can answer.
 *
 * Governing design:
 * `docs/specs/Concepts/Effect Taxonomy.md` and
 * `docs/specs/Concepts/Permission Kernel.md`.
 *
 * @since 0.1.0
 */
import { Context, Layer } from "effect"

/**
 * Workspace-root configuration.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Service {
  readonly root: string
}

/**
 * The workspace-root service tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class Workspace extends Context.Service<Workspace, Service>()("@smthrs/kernel/Workspace") {}

/**
 * Constructs workspace-root configuration.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (root: string): Service => Workspace.of({ root })

/**
 * Provides a workspace root.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (root: string): Layer.Layer<Workspace> => Layer.succeed(Workspace, make(root))

/**
 * Constructs a relative workspace-root stub for tests.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop: Service = make(".")

/**
 * Provides a relative workspace-root stub for tests.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop: Layer.Layer<Workspace> = Layer.succeed(Workspace, makeNoop)
