import { randomUUID } from "node:crypto";
import { rewindLockStore } from "./rewindLockStore.js";

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
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
 * Acquire a durable single-flight lease for one run. The database compare-and-set
 * makes the exclusion visible to CLI, MCP, and server processes that share the
 * Smithers store. An expired lease can be replaced atomically.
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
  const nowMs = options.nowMs ?? (() => Date.now());
  const leaseTtlMs = options.leaseTtlMs ?? REWIND_LEASE_TTL_MS;
  if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new TypeError("leaseTtlMs must be a positive finite number.");
  }

  // This advisory guard avoids needless DB work for callers in the same
  // process. The durable row below remains the source of truth.
  if (rewindLockStore.has(runId)) {
    return null;
  }

  const ownerToken = randomUUID();
  rewindLockStore.set(runId, ownerToken);
  const storage = resolveStorage(adapter);
  let expiresAtMs = nowMs() + leaseTtlMs;

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
      if (rewindLockStore.get(runId) === ownerToken) {
        rewindLockStore.delete(runId);
      }
      return null;
    }
  } catch (error) {
    if (rewindLockStore.get(runId) === ownerToken) {
      rewindLockStore.delete(runId);
    }
    throw error;
  }

  let released = false;
  let renewing = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let renewalTimer = null;

  const loseLocalOwnership = () => {
    if (rewindLockStore.get(runId) === ownerToken) {
      rewindLockStore.delete(runId);
    }
  };

  const renew = async () => {
    if (released || rewindLockStore.get(runId) !== ownerToken) {
      return false;
    }
    const renewedAtMs = nowMs();
    const nextExpiresAtMs = renewedAtMs + leaseTtlMs;
    const rows = await runWrite(adapter, `renew rewind lease ${runId}`, () =>
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

  if (options.autoRenew !== false) {
    renewalTimer = setInterval(() => {
      if (renewing || released) {
        return;
      }
      renewing = true;
      void renew()
        .catch(() => undefined)
        .finally(() => {
          renewing = false;
        });
    }, Math.max(1, Math.floor(leaseTtlMs / 3)));
    renewalTimer.unref?.();
  }

  return {
    runId,
    ownerToken,
    get expiresAtMs() {
      return expiresAtMs;
    },
    renew,
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
