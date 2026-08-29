/**
 * Explicit kernel decision for the Effect path service.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Host Adapters.md`.
 *
 * @since 0.1.0
 */
import { Layer, Path as EffectPath } from "effect"

/**
 * Effect's lexical path-service shape.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Path = EffectPath.Path

/**
 * The unchanged underlying path-service tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export const Path = EffectPath.Path

/**
 * Transparently re-provides Effect's path service. Path manipulation is pure
 * and lexical, so it requires no capability check. This explicit layer proves
 * that every member of the Host services closed list has a kernel decision.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer: Layer.Layer<Path, never, Path> = Layer.effect(Path, Path)
