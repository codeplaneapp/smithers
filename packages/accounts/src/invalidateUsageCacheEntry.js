import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { accountsRoot } from "./accountsRoot.js";

/**
 * Best-effort removal of a label's cached usage after an account replacement.
 * Cache failures must not undo a successfully persisted account change.
 *
 * @param {string} label
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean} whether an entry was removed
 */
export function invalidateUsageCacheEntry(label, env) {
  const path = join(accountsRoot(env), "usage-cache.json");
  let tmp;
  try {
    const cache = JSON.parse(readFileSync(path, "utf8"));
    if (
      !cache ||
      typeof cache !== "object" ||
      cache.version !== 1 ||
      !cache.entries ||
      typeof cache.entries !== "object" ||
      Array.isArray(cache.entries) ||
      !Object.prototype.hasOwnProperty.call(cache.entries, label)
    ) {
      return false;
    }
    delete cache.entries[label];
    tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    if (tmp) {
      try {
        rmSync(tmp, { force: true });
      } catch {}
    }
    return false;
  }
}
