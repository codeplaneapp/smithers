import { randomUUID } from "node:crypto";
import { parseSubflowChildRunId } from "@smthrs/graph/subflow-run-lineage";
import { rewindLockStore } from "./rewindLockStore.js";

/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./RewindLockHandle.ts").RewindLockHandle} RewindLockHandle */

export const REWIND_LEASE_TTL_MS = 60_000;

/**
 * @param {SmithersDb} adapter
 */
function resolveStorage(adapter) {
  const storage = adapter?.internalStorage;
  if (!storage || typeof storage.queryAllRaw !== "function") {
    throw new TypeError("Rewind locking requires a SmithersDb backed by internalStorage.");
  }
  return storage;
}

/**
 * Keep rewind lease writes on the adapter's serialized, retrying write path.
 *
 * @template T
 * @param {SmithersDb} adapter
 * @param {string} label
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
async function runWrite(adapter, label, operation) {
  return await adapter.write(label, operation);
}

/**
 * Parent and child runs may mutate the same checkout, so their destructive
 * time-travel operations share the top-level run's lease.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<string>}
 */
export async function resolveRewindLeaseRunId(adapter, runId) {
  if (typeof adapter?.getRun !== "function") return runId;
  const storage = resolveStorage(adapter);
  let leaseRunId = runId;
  const seen = new Set();
  while (!seen.has(leaseRunId)) {
    seen.add(leaseRunId);
    const runs = await storage.queryAllRaw(
      `SELECT parent_run_id, config_json
         FROM _smithers_runs
        WHERE run_id = ?
        LIMIT 1`,
      [leaseRunId],
    );
    const run = runs[0]
      ? {
          parentRunId: runs[0].parent_run_id ?? runs[0].parentRunId ?? null,
          configJson: runs[0].config_json ?? runs[0].configJson ?? null,
        }
      : undefined;
    if (!run?.parentRunId) break;
    // Forks own an independent workspace and therefore an independent lease.
    // Subflows (including explicitly named child runs) have parentRunId but no
    // branch row; ContinueAsNew has a structured branch label and keeps using
    // the same workspace. Resolve from those durable rows instead of parsing
    // the generated `:child:` run-id grammar.
    const branches = await storage.queryAllRaw(
      `SELECT branch_label
         FROM _smithers_branches
        WHERE run_id = ?
        LIMIT 1`,
      [leaseRunId],
    );
    const branchLabel = branches[0]?.branch_label ?? branches[0]?.branchLabel ?? null;
    if (branches.length > 0 && branchLabel !== "continue-as-new") break;
    if (branches.length === 0) {
      let explicitSubflow = false;
      try {
        const config = JSON.parse(run.configJson ?? "{}");
        explicitSubflow = config?.subflowWorkspaceParentRunId === run.parentRunId;
      } catch {
        explicitSubflow = false;
      }
      if (!explicitSubflow && !parseSubflowChildRunId(leaseRunId, run.parentRunId)) break;
    }
    leaseRunId = run.parentRunId;
  }
  return leaseRunId;
}

/**
 * Acquire a durable single-flight lease for one run lineage. The database
 * compare-and-set makes the exclusion visible to CLI, MCP, and server
 * processes that share the Smithers store. An expired lease can be replaced
 * atomically.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {{
 *   nowMs?: () => number;
 *   leaseTtlMs?: number;
 *   autoRenew?: boolean;
 * }} [options]
 * @returns {Promise<RewindLockHandle | null>}
 */
export async function acquireRewindLock(adapter, runId, options = {}) {
  const requestedRunId = runId;
  const nowMs = options.nowMs ?? (() => Date.now());
  const leaseTtlMs = options.leaseTtlMs ?? REWIND_LEASE_TTL_MS;
  if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new TypeError("leaseTtlMs must be a positive finite number.");
  }
  const storage = resolveStorage(adapter);
  runId = await resolveRewindLeaseRunId(adapter, runId);

  // This advisory guard avoids needless DB work for callers in the same
  // process. The durable row below remains the source of truth.
  if (rewindLockStore.has(runId)) {
    const existingOwnerToken = rewindLockStore.get(runId);
    if (requestedRunId !== runId && existingOwnerToken) {
      rewindLockStore.set(requestedRunId, existingOwnerToken);
    }
    return null;
  }

  const ownerToken = randomUUID();
  rewindLockStore.set(runId, ownerToken);
  rewindLockStore.set(requestedRunId, ownerToken);
  let expiresAtMs = nowMs() + leaseTtlMs;
  const loseLocalOwnership = () => {
    for (const [lockedRunId, token] of rewindLockStore) {
      if (token === ownerToken) {
        rewindLockStore.delete(lockedRunId);
      }
    }
  };

  try {
    const rows = await runWrite(adapter, `acquire rewind lease ${runId}`, () =>
      storage.queryAllRaw(
        `INSERT INTO _smithers_rewind_leases (run_id, owner_token, expires_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT (run_id) DO UPDATE SET
           owner_token = excluded.owner_token,
           expires_at_ms = excluded.expires_at_ms
         WHERE _smithers_rewind_leases.expires_at_ms <= ?
         RETURNING owner_token`,
        [runId, ownerToken, expiresAtMs, nowMs()],
      ),
    );
    const acquiredToken = rows[0]?.owner_token ?? rows[0]?.ownerToken;
    if (acquiredToken !== ownerToken) {
      loseLocalOwnership();
      return null;
    }
  } catch (error) {
    loseLocalOwnership();
    throw error;
  }

  let released = false;
  let renewing = false;
  /** @type {Error | null} */
  let fencingError = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let renewalTimer = null;

  /**
   * @param {unknown} cause
   */
  const tripFence = (cause) => {
    if (!fencingError) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      fencingError = new Error(
        `Rewind lease renewal failed for ${runId}: ${detail}`,
        cause instanceof Error ? { cause } : undefined,
      );
    }
    loseLocalOwnership();
    if (renewalTimer) {
      clearInterval(renewalTimer);
      renewalTimer = null;
    }
  };

  const renew = async () => {
    if (fencingError) {
      throw fencingError;
    }
    if (released || rewindLockStore.get(runId) !== ownerToken) {
      return false;
    }
    const renewedAtMs = nowMs();
    const nextExpiresAtMs = renewedAtMs + leaseTtlMs;
    let rows;
    try {
      rows = await runWrite(adapter, `renew rewind lease ${runId}`, () =>
        storage.queryAllRaw(
          `UPDATE _smithers_rewind_leases
              SET expires_at_ms = ?
            WHERE run_id = ?
              AND owner_token = ?
              AND expires_at_ms > ?
          RETURNING owner_token`,
          [nextExpiresAtMs, runId, ownerToken, renewedAtMs],
        ),
      );
    } catch (error) {
      tripFence(error);
      throw fencingError;
    }
    const renewedToken = rows[0]?.owner_token ?? rows[0]?.ownerToken;
    if (renewedToken !== ownerToken) {
      loseLocalOwnership();
      if (renewalTimer) {
        clearInterval(renewalTimer);
        renewalTimer = null;
      }
      return false;
    }
    expiresAtMs = nextExpiresAtMs;
    return true;
  };

  const checkStillHeld = async () => {
    if (fencingError) {
      throw fencingError;
    }
    if (released || rewindLockStore.get(runId) !== ownerToken) {
      return false;
    }
    const checkedAtMs = nowMs();
    let rows;
    try {
      // A no-op UPDATE both verifies ownership and locks the lease row for the
      // lifetime of an enclosing destructive transaction.
      rows = await storage.queryAllRaw(
        `UPDATE _smithers_rewind_leases
            SET expires_at_ms = expires_at_ms
          WHERE run_id = ?
            AND owner_token = ?
            AND expires_at_ms > ?
        RETURNING owner_token`,
        [runId, ownerToken, checkedAtMs],
      );
    } catch (error) {
      tripFence(error);
      throw fencingError;
    }
    const heldToken = rows[0]?.owner_token ?? rows[0]?.ownerToken;
    if (heldToken !== ownerToken) {
      loseLocalOwnership();
      if (renewalTimer) {
        clearInterval(renewalTimer);
        renewalTimer = null;
      }
      return false;
    }
    return true;
  };

  if (options.autoRenew !== false) {
    renewalTimer = setInterval(
      () => {
        if (renewing || released) {
          return;
        }
        renewing = true;
        void renew()
          .catch((error) => {
            tripFence(error);
          })
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(1, Math.floor(leaseTtlMs / 3)),
    );
    renewalTimer.unref?.();
  }

  return {
    runId,
    ownerToken,
    get expiresAtMs() {
      return expiresAtMs;
    },
    renew,
    checkStillHeld,
    async release() {
      if (released) {
        return false;
      }
      released = true;
      if (renewalTimer) {
        clearInterval(renewalTimer);
        renewalTimer = null;
      }
      try {
        const rows = await runWrite(adapter, `release rewind lease ${runId}`, () =>
          storage.queryAllRaw(
            `DELETE FROM _smithers_rewind_leases
              WHERE run_id = ? AND owner_token = ?
            RETURNING owner_token`,
            [runId, ownerToken],
          ),
        );
        const releasedToken = rows[0]?.owner_token ?? rows[0]?.ownerToken;
        return releasedToken === ownerToken;
      } finally {
        loseLocalOwnership();
      }
    },
  };
}
