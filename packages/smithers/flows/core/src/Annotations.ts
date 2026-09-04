/**
 * Typed immutable annotations attached to flow graph values.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
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

/**
 * Annotation key for a node's scheduling priority.
 *
 * The value is a signed integer that orders ready work: a scheduler runs a
 * higher number before a lower one. Priority is a scheduling hint, never part
 * of step identity, so raising it never invalidates a cached step.
 *
 * @category annotations
 * @since 0.1.0
 * @slop
 */
export const Priority = Context.Service<number>("flows/core/Annotations/Priority")
