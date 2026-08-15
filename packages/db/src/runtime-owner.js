import { hostname as systemHostname } from "node:os";

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeRuntimeOwnerHostname(value) {
  return typeof value === "string" ? value.trim().replace(/\.+$/u, "").toLowerCase() : "";
}

/**
 * Build the host-scoped owner id persisted by an engine process.
 * @param {number} pid
 * @param {string} ownerHostname
 * @param {string} sessionId
 * @returns {string}
 */
export function formatRuntimeOwnerId(pid, ownerHostname, sessionId) {
  const normalizedHostname = normalizeRuntimeOwnerHostname(ownerHostname);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError("runtime owner pid must be a positive integer");
  }
  if (!normalizedHostname) {
    throw new TypeError("runtime owner hostname must be non-empty");
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("runtime owner session id must be non-empty");
  }
  return `pid:${pid}@${encodeURIComponent(normalizedHostname)}:${sessionId}`;
}

/**
 * Parse a host-scoped owner id. Legacy `pid:<pid>:<session>` and bare-pid ids
 * have no host identity, so they retain the historical single-host behavior.
 *
 * @param {string | null | undefined} runtimeOwnerId
 * @param {string} [localHostname]
 * @returns {{ readonly pid: number, readonly hostname: string | null, readonly isLocal: boolean } | null}
 */
export function parseRuntimeOwnerIdentity(runtimeOwnerId, localHostname = systemHostname()) {
  if (!runtimeOwnerId) return null;
  const trimmed = runtimeOwnerId.trim();
  if (trimmed.length === 0) return null;

  const scoped = trimmed.match(/^pid:(\d+)@([^:]+)(?::.*)?$/i);
  if (scoped) {
    const pid = Number(scoped[1]);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    let decodedHostname;
    try {
      decodedHostname = decodeURIComponent(scoped[2]);
    } catch {
      return null;
    }
    const ownerHostname = normalizeRuntimeOwnerHostname(decodedHostname);
    const normalizedLocalHostname = normalizeRuntimeOwnerHostname(localHostname);
    if (!ownerHostname || !normalizedLocalHostname) return null;
    return {
      pid,
      hostname: ownerHostname,
      isLocal: ownerHostname === normalizedLocalHostname,
    };
  }

  const legacy = trimmed.match(/^pid:(\d+)(?::.*)?$/i);
  const rawPid = legacy ? legacy[1] : /^\d+$/.test(trimmed) ? trimmed : null;
  if (rawPid === null) return null;
  const pid = Number(rawPid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, hostname: null, isLocal: true };
}

/**
 * Return a PID only when it belongs to this host. Remote owners deliberately
 * fall back to durable heartbeat liveness instead of probing a local process
 * that merely reused the same PID.
 *
 * @param {string | null | undefined} runtimeOwnerId
 * @param {string} [localHostname]
 * @returns {number | null}
 */
export function parseRuntimeOwnerPid(runtimeOwnerId, localHostname = systemHostname()) {
  const identity = parseRuntimeOwnerIdentity(runtimeOwnerId, localHostname);
  return identity?.isLocal ? identity.pid : null;
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we may not signal it — still alive.
    return /** @type {{ code?: string }} */ (error)?.code === "EPERM";
  }
}
