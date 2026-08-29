/**
 * What one migration run was asked to do.
 *
 * The options are a schema rather than an interface because they are the
 * migration flow's payload: they cross the journal, and a replay decodes
 * exactly what the first attempt was given. The CLI decodes the same schema
 * from its flags, so a flag typo fails with a field path instead of a
 * `undefined` three steps later.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"

/**
 * What a run is allowed to do to the project.
 *
 * `scan` reads. `plan` reads and writes the report. Only `apply` edits source,
 * and only `apply` is gated.
 *
 * @category models
 * @since 0.1.0
 */
export const Mode = Schema.Literals(["scan", "plan", "apply"])

/**
 * What a run is allowed to do to the project.
 *
 * @category models
 * @since 0.1.0
 */
export type Mode = typeof Mode.Type

/**
 * Command overrides for the verification step, when the project's own
 * manifests do not name the commands the operator wants run.
 *
 * @category models
 * @since 0.1.0
 */
export const Commands = Schema.Struct({
  install: Schema.optional(Schema.String),
  format: Schema.optional(Schema.String),
  typecheck: Schema.optional(Schema.Array(Schema.String)),
  test: Schema.optional(Schema.String)
})

/**
 * Command overrides for the verification step.
 *
 * @category models
 * @since 0.1.0
 */
export type Commands = typeof Commands.Type

/**
 * Where the migration writes and what it calls the target directory.
 *
 * @category models
 * @since 0.1.0
 */
export const Layout = Schema.Struct({
  flowsDir: Schema.String
})

/**
 * Everything one migration run was asked to do.
 *
 * `seat` is a seat *id* the host's `SeatResolver` understands, not a model
 * name this package knows: the resolver owns that vocabulary. Absent means the
 * host decides, and a host with no answer refuses the run by name.
 *
 * @category models
 * @since 0.1.0
 */
export const MigrateOptions = Schema.Struct({
  root: Schema.String,
  mode: Mode,
  seat: Schema.optional(Schema.String),
  allowUnsafe: Schema.optional(Schema.Union([Schema.Literal("all"), Schema.Array(Schema.String)])),
  acknowledgeRunState: Schema.optional(Schema.Boolean),
  allowNoVcs: Schema.optional(Schema.Boolean),
  keepOldSources: Schema.optional(Schema.Boolean),
  units: Schema.optional(Schema.Array(Schema.String)),
  maxRepairRounds: Schema.optional(Schema.Int),
  commands: Schema.optional(Commands),
  reportDir: Schema.optional(Schema.String),
  layout: Schema.optional(Layout)
})

/**
 * Everything one migration run was asked to do.
 *
 * @category models
 * @since 0.1.0
 */
export type MigrateOptions = typeof MigrateOptions.Type

/**
 * Where the report, the archive, and the no-VCS backups live, relative to the
 * project root.
 *
 * @category models
 * @since 0.1.0
 */
export const defaultReportDir = ".smithers-migrate"

/**
 * The directory the migrated flows are written to, relative to the project
 * root. It follows the registry's own project source layout.
 *
 * @category models
 * @since 0.1.0
 */
export const defaultFlowsDir = "flows"

/**
 * How many times a failing unit is handed back to the agent with the failing
 * command output before the run restores its checkpoint and moves on.
 *
 * @category models
 * @since 0.1.0
 */
export const defaultMaxRepairRounds = 3

/**
 * The report directory this run writes into.
 *
 * @category accessors
 * @since 0.1.0
 */
export const reportDir = (options: MigrateOptions): string => options.reportDir ?? defaultReportDir

/**
 * The flows directory this run migrates into.
 *
 * @category accessors
 * @since 0.1.0
 */
export const flowsDir = (options: MigrateOptions): string => options.layout?.flowsDir ?? defaultFlowsDir

/**
 * The repair budget this run allows, floored at zero.
 *
 * @category accessors
 * @since 0.1.0
 */
export const maxRepairRounds = (options: MigrateOptions): number =>
  Math.max(0, options.maxRepairRounds ?? defaultMaxRepairRounds)
