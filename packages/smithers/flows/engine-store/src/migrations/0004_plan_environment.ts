/**
 * Bind source observations to the runtime identity that admitted them.
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Older heads retain NULL: their original runtime environment is unknowable.
 * New heads require an environment fingerprint, immutable for their lifetime.
 * @since 1.0.0
 * @category migrations
 */
export const planEnvironment: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE flows_plan_input_heads ADD COLUMN environment_digest TEXT
    CHECK (environment_digest IS NULL OR length(environment_digest) > 0)`
  yield* sql`CREATE TRIGGER flows_plan_input_heads_environment_required
    BEFORE INSERT ON flows_plan_input_heads WHEN NEW.environment_digest IS NULL
    BEGIN SELECT RAISE(ABORT, 'new plan input heads require an environment identity'); END`
  yield* sql`CREATE TRIGGER flows_plan_input_heads_environment_immutable
    BEFORE UPDATE ON flows_plan_input_heads WHEN NEW.environment_digest IS NOT OLD.environment_digest
    BEGIN SELECT RAISE(ABORT, 'plan input environment identity is immutable'); END`
})
