/**
 * The factory projection: `.smithers/factory.json`, the committed JSON that
 * `//:factoryProjection` writes from `S.Factory({...})` in
 * `.smithers/FACTORY.ts` (Factory design session 2026-09-07 §4; spec 08 §1;
 * RULINGS 21). The public mirror serves it through the contents route that
 * is already allowlisted for signed-out reads, so the Dispatcher card renders
 * the declared rules before anyone signs in.
 *
 * Only the part the app reads is typed here. Field names are the
 * declaration's own: `summary`, `flows` (the flow ids the factory declares),
 * and `on`, the Dispatcher table. `on` is a record in the declaration (event
 * key to a flow id or a list of them); the projection flattens it to rows so
 * each row can carry the "Visible as" sentence of design §7 as `description`.
 * A row's `event` is a key of the event vocabulary (spec 08 §3):
 * `issue.opened`, `issue.labeled:<label>`, `change.landed`,
 * `github.push:<branch>`, `schedule:<cron>`, `box.session.ended`,
 * `nomination`, `manual`.
 *
 * @since 1.0.0
 */
import { z } from "zod"

/**
 * Where the projection lives in the repository tree.
 *
 * @since 1.0.0
 * @category constants
 */
export const FACTORY_PROJECTION_PATH = ".smithers/factory.json"

/**
 * One row of the Dispatcher table: the event, the flow or flows it starts,
 * and the sentence the card shows for it when the declaration names one.
 *
 * @since 1.0.0
 * @category schemas
 */
export const FactoryRuleSchema = z.object({
  event: z.string().min(1),
  flow: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  description: z.string().optional()
})

/**
 * The decoded value accepted by {@link FactoryRuleSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type FactoryRule = z.infer<typeof FactoryRuleSchema>

/**
 * The projection the app reads. `summary` and `flows` are optional so a
 * projection that carries only the Dispatcher table still decodes.
 *
 * @since 1.0.0
 * @category schemas
 */
export const FactoryProjectionSchema = z.object({
  summary: z.string().optional(),
  flows: z.array(z.string().min(1)).optional(),
  on: z.array(FactoryRuleSchema)
})

/**
 * The decoded value accepted by {@link FactoryProjectionSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type FactoryProjection = z.infer<typeof FactoryProjectionSchema>

/**
 * The flow ids one rule starts, in declaration order.
 *
 * @since 1.0.0
 * @category accessors
 */
export const ruleFlows = (rule: FactoryRule): ReadonlyArray<string> =>
  typeof rule.flow === "string" ? [rule.flow] : rule.flow
