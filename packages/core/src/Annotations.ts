/**
 * Typed immutable annotations attached to flow graph values.
 *
 * Governing contracts:
 * `docs/specs/Concepts/Flow Builder Brief.md`,
 * `docs/specs/Concepts/Effect Taxonomy.md`, and
 * `docs/specs/Concepts/Placement.md`.
 *
 * @since 0.0.0
 */
import { Context, type Option } from "effect"
import type * as EffectsModel from "./Effects.ts"
import type * as PlacementModel from "./Placement.ts"

/**
 * Options identifying a worktree lane for a node.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface LaneOptions {
  readonly id: string
  readonly landing?: "merge-queue" | "manual" | undefined
}

/**
 * The empty annotation bag.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const empty: Context.Context<never> = Context.empty()

/**
 * Adds or replaces one annotation without changing the original context.
 *
 * @category adders
 * @since 0.0.0
 * @slop
 */
export const add = Context.add

/**
 * Merges parent and child annotation bags. Child values override parent values
 * for matching keys.
 *
 * @category combining
 * @since 0.0.0
 * @slop
 */
export const merge = (parent: Context.Context<never>, child: Context.Context<never>): Context.Context<never> =>
  Context.merge(parent, child)

/**
 * Safely retrieves an annotation, returning `Option.none()` when it is absent.
 *
 * @category getters
 * @since 0.0.0
 * @slop
 */
export const getOption = <I, S>(context: Context.Context<never>, key: Context.Key<I, S>): Option.Option<S> =>
  Context.getOption(context, key)

/**
 * Annotation key for a node's placement directive.
 *
 * @category annotations
 * @since 0.0.0
 * @slop
 */
export const Placement = Context.Service<PlacementModel.Placement>("flows/core/Annotations/Placement")

/**
 * Annotation key for a flow or node effect declaration.
 *
 * @category annotations
 * @since 0.0.0
 * @slop
 */
export const Effects = Context.Service<EffectsModel.Declaration>("flows/core/Annotations/Effects")

/**
 * Annotation key for a node's explicit worktree lane.
 *
 * @category annotations
 * @since 0.0.0
 * @slop
 */
export const Lane = Context.Service<LaneOptions>("flows/core/Annotations/Lane")
