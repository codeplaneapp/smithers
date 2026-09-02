/**
 * Score-store migrations.
 *
 * @since 0.1.0
 */
import * as Layer from "effect/Layer"
import * as Migrator from "effect/unstable/sql/Migrator"
import scores from "./0001_scores.ts"
import jobs from "./0002_score_jobs.ts"
import failureCodes from "./0003_score_failure_codes.ts"
import requiredFailureCodes from "./0004_require_failure_codes.ts"

const migrations = {
  "0001_scores": scores,
  "0002_score_jobs": jobs,
  "0003_score_failure_codes": failureCodes,
  "0004_require_failure_codes": requiredFailureCodes
}

/**
 * Applies all score-store migrations.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = Migrator.make({})({
  loader: Migrator.fromRecord(migrations),
  table: "flows_scorers_migrations"
})

/**
 * Applies score-store migrations when the layer is constructed.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = Layer.effectDiscard(run)
