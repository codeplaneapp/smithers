import type { GatewayScoreRow as ProtocolGatewayScoreRow } from "@smithers-orchestrator/protocol/gateway-rpc";

/**
 * One row of the `scores` collection — the live `listScores` RPC response shape.
 *
 * The gateway builds each row from the `_smithers_scorers` table (snake→camel
 * cased by the storage layer) — the SAME table a run's scorer/eval nodes write
 * via `insertScorerResult` and the `smithers scores RUN_ID` CLI reads.
 * `listScores` is per-run (keyed by `runId`, optionally one `nodeId`), so a run
 * can carry many rows: the same scorer fires across nodes/iterations/attempts.
 *
 * Field provenance (verified against
 * `packages/db/src/internal-schema/smithersScorers.js` + the `listScores`
 * handler in `packages/server/src/gateway.js`):
 *  - `runId`       — `_smithers_scorers.run_id`.
 *  - `nodeId`      — `_smithers_scorers.node_id`.
 *  - `iteration`   — `_smithers_scorers.iteration`.
 *  - `attempt`     — `_smithers_scorers.attempt`.
 *  - `scorerId`    — `_smithers_scorers.scorer_id`.
 *  - `scorerName`  — `_smithers_scorers.scorer_name` (the human label).
 *  - `source`      — `_smithers_scorers.source` (`live` or `batch` for new rows;
 *                    the public field remains `string` for legacy rows).
 *  - `score`       — `_smithers_scorers.score` (the numeric verdict).
 *  - `reason`      — `_smithers_scorers.reason` (null when none recorded).
 *  - `scoredAtMs`  — `_smithers_scorers.scored_at_ms`.
 *  - `latencyMs`   — `_smithers_scorers.latency_ms` (null when unmeasured).
 *  - `durationMs`  — `_smithers_scorers.duration_ms` (null when unmeasured).
 *
 * There is NO token/cost data in this table — those Metrics-tab tiles are
 * computed client-side from these rows and em-dashed when absent.
 */
export type GatewayScoreRow = ProtocolGatewayScoreRow;
