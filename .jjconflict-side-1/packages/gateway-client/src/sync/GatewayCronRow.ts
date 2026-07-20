/**
 * One row of the `crons` collection — the live `cronList` RPC response shape.
 *
 * The gateway builds each row from the `_smithers_cron` table (snake→camel cased
 * by the storage layer) and appends `workflow` (the registered workflow KEY,
 * derived from the cron's `workflowPath`). `cronList` returns ALL crons
 * (enabled + disabled), so `enabled` is load-bearing for consumers.
 *
 * Field provenance (verified against `packages/db/src/internal-schema/smithersCron.js`
 * + the `listCrons` handler in `packages/server/src/gateway.js`):
 *  - `cronId`        — `_smithers_cron.cron_id` PK.
 *  - `pattern`       — `_smithers_cron.pattern` (5-field cron expression).
 *  - `workflowPath`  — `_smithers_cron.workflow_path` (the source file path).
 *  - `workflow`      — the registered workflow KEY (appended by the server; the
 *                      handle `cronCreate` expects when recreating a cron).
 *  - `enabled`       — `_smithers_cron.enabled` (coerced to a real boolean).
 *  - `createdAtMs`   — `_smithers_cron.created_at_ms`.
 *  - `lastRunAtMs`   — `_smithers_cron.last_run_at_ms` (null until first run).
 *  - `nextRunAtMs`   — `_smithers_cron.next_run_at_ms` (null when unscheduled).
 *  - `errorJson`     — `_smithers_cron.error_json` (null when healthy).
 */
export type GatewayCronRow = {
  cronId: string;
  pattern: string;
  workflowPath: string;
  workflow: string;
  enabled: boolean;
  createdAtMs?: number;
  lastRunAtMs?: number | null;
  nextRunAtMs?: number | null;
  errorJson?: string | null;
};
