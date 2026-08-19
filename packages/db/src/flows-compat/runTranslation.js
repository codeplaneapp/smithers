/**
 * Translation between a `_smithers_runs` row and the `flows_runs` row the flows
 * `RunStore` fences on.
 *
 * The two schemas disagree in one load-bearing way. `flows_runs` allows six
 * statuses and enforces, in SQL, that `running` carries an owner triple and a
 * heartbeat while every other status carries neither. Smithers has more
 * statuses, and a run whose engine died stays `running` with a null
 * `runtime_owner_id`. That state is what `claimRunForResume` exists to take
 * over, so it maps onto flows' `suspended`: durable work that is not currently
 * owned.
 */
import { toFlowsOwnerId } from "./ownerIdentity.js";

/** The statuses `flows_runs.status` accepts. */
export const FLOWS_RUN_STATUSES = ["pending", "running", "suspended", "completed", "failed", "cancelled"];

/**
 * Statuses a Smithers run uses while it is parked rather than executing.
 * `DB_RUN_ALLOWED_STATUSES` in `adapter.js` is the full list.
 */
const SMITHERS_WAITING_STATUSES = new Set([
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "waiting-quota",
  "paused",
]);

/**
 * Map a Smithers run status onto a flows run status.
 *
 * @param {string | null | undefined} status
 * @param {{ runtimeOwnerId?: string | null | undefined }} [ownership]
 * @returns {"pending" | "running" | "suspended" | "completed" | "failed" | "cancelled"}
 */
export function toFlowsRunStatus(status, ownership = {}) {
  const normalized = typeof status === "string" ? status.trim().toLowerCase() : "";
  switch (normalized) {
    case "running":
      // flows refuses an owner-less `running` row. An unowned Smithers run is
      // exactly a resumable one, which flows calls `suspended`.
      return toFlowsOwnerId(ownership.runtimeOwnerId ?? null) ? "running" : "suspended";
    case "pending":
    case "queued":
      return "pending";
    case "finished":
    case "completed":
      return "completed";
    case "continued":
      // A run that trampolined into a successor is done writing; the successor
      // is a separate run with its own row.
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return SMITHERS_WAITING_STATUSES.has(normalized) ? "suspended" : "suspended";
  }
}

/**
 * The exact fields `RunStore.claim`, `claimAndOwn`, and `steal` compare against
 * the persisted row.
 *
 * @param {Record<string, unknown>} row a `_smithers_runs` row (camelCase or snake_case)
 * @returns {{ status: string; owner: { hostId: string; pid: number; nonce: string } | null; heartbeatAtMs: number | null }}
 */
export function toFlowsRunSnapshot(row) {
  const runtimeOwnerId = /** @type {string | null} */ (row.runtimeOwnerId ?? row.runtime_owner_id ?? null);
  const status = toFlowsRunStatus(/** @type {string} */ (row.status), { runtimeOwnerId });
  const owner = status === "running" ? toFlowsOwnerId(runtimeOwnerId) : null;
  const rawHeartbeat = row.heartbeatAtMs ?? row.heartbeat_at_ms ?? null;
  return {
    status,
    owner,
    // The heartbeat column is only populated on a `running` row, because
    // `flows_runs` forbids it anywhere else.
    heartbeatAtMs: owner === null || rawHeartbeat === null ? null : Number(rawHeartbeat),
  };
}

/**
 * The `flows_runs.state_json` payload for a run this compat module mirrors.
 * flows returns it byte for byte and never interprets it, so it records where
 * the row came from and the Smithers status the flows status was derived from.
 *
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
export function toFlowsRunStateJson(row) {
  return JSON.stringify({
    source: "smithers-db-compat",
    smithersStatus: row.status ?? null,
    workflowName: row.workflowName ?? row.workflow_name ?? null,
  });
}
