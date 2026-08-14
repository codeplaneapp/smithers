import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { SmithersError } from "@smthrs/errors";
import { findSmithersAnchorDir } from "smthrs/findSmithersAnchorDir";
import { openSmithersStore } from "smthrs/openSmithersStore";
import { cliWorkspace } from "./cliWorkspace.js";
/** @typedef {import("./FindDbWaitOptions.ts").FindDbWaitOptions} FindDbWaitOptions */
/** @typedef {import("./DbMarkerChecks.ts").DbMarkerChecks} DbMarkerChecks */

/** @type {DbMarkerChecks} */
const realDbMarkerChecks = { fileExists: existsSync };

/**
 * Walk from `from` (default: cwd) upward looking for smithers.db.
 *
 * Resolution order:
 *   1. The directory containing the nearest `.smithers/` anchor (walking up).
 *      If a `smithers.db` lives there, return it — even when a stray
 *      `smithers.db` also exists closer to `from`.
 *   2. Any `smithers.db` encountered while walking upward (original behaviour,
 *      kept as fallback for projects that have no `.smithers/` pack yet).
 *
 * If more than one `smithers.db` is found along the walk, a warning is emitted
 * to stderr so the user knows which one was chosen.
 *
 * Returns the absolute path to the database file.
 *
 * @param {string} [from]
 * @param {DbMarkerChecks} [markerChecks] Defaults to the real filesystem; tests
 *   inject probes bounded to their own sandbox so the walk cannot escape into
 *   the shared OS tmp root, which may hold a stray `smithers.db`.
 * @returns {string}
 */
export function findSmithersDb(from, markerChecks = realDbMarkerChecks) {
  const startDir = resolve(from ?? process.cwd());

  // Collect every smithers.db along the upward walk so we can warn about
  // multiple candidates and enforce the anchor-preference rule.
  /** @type {string[]} */
  const allCandidates = [];
  let dir = startDir;
  while (true) {
    const candidate = resolve(dir, "smithers.db");
    if (markerChecks.fileExists(candidate)) {
      allCandidates.push(candidate);
    }
    const parent = dirname(dir);
    // Stop at the root of the drive/volume that `from` is on. Windows CI may
    // put tmpdir() on a different drive than process.cwd(), so resolve("/")
    // can point at the wrong root and leave this loop stuck.
    if (parent === dir) break;
    dir = parent;
  }

  if (allCandidates.length === 0) {
    throw new SmithersError(
      "CLI_DB_NOT_FOUND",
      `No smithers workspace found from ${startDir}; pass --db <path> or run 'smithers up <workflow>' from a Smithers workspace to create smithers.db.`,
      { cwd: startDir },
    );
  }

  // Prefer the smithers.db that sits at the project anchor (nearest .smithers/).
  const anchorDir = findSmithersAnchorDir(startDir);
  const anchorDb = anchorDir ? resolve(anchorDir, "smithers.db") : undefined;
  // If an anchor directory was found but its DB hasn't been created yet, do NOT
  // fall back to a stray smithers.db from a parent or sibling directory — that
  // would silently cross the project boundary.  Instead throw CLI_DB_NOT_FOUND so
  // the caller (or waitForSmithersDb) can retry until the anchor DB appears.
  if (anchorDb && !markerChecks.fileExists(anchorDb)) {
    throw new SmithersError(
      "CLI_DB_NOT_FOUND",
      `No smithers.db found at project anchor ${anchorDir}. Run 'smithers up <workflow>' to start a run first.`,
    );
  }
  const chosen = anchorDb ?? allCandidates[0];

  if (allCandidates.length > 1) {
    const others = allCandidates.filter((p) => p !== chosen);
    process.stderr.write(
      `[smithers] Warning: multiple smithers.db files found along the directory tree.\n` +
        `  Using: ${chosen}\n` +
        others.map((p) => `  Ignored: ${p}`).join("\n") +
        "\n",
    );
  }

  return chosen;
}
/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * @param {string} [from]
 * @param {FindDbWaitOptions} [opts]
 * @param {DbMarkerChecks} [markerChecks]
 * @returns {Promise<string>}
 */
export async function waitForSmithersDb(from, opts = {}, markerChecks = realDbMarkerChecks) {
  const timeoutMs = Math.max(0, opts.timeoutMs ?? 0);
  const intervalMs = Math.max(1, opts.intervalMs ?? 100);
  const startedAt = Date.now();
  while (true) {
    try {
      return findSmithersDb(from, markerChecks);
    } catch (err) {
      if (!(err instanceof SmithersError) || err.code !== "CLI_DB_NOT_FOUND") {
        throw err;
      }
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        throw err;
      }
      await sleep(Math.min(intervalMs, timeoutMs - elapsedMs));
    }
  }
}
/**
 * Find and open the resolved Smithers store.
 *
 * @param {string} [from]
 * @param {FindDbWaitOptions} [opts]
 * @returns {Promise<Pick<import("smthrs/OpenSmithersStoreResult").OpenSmithersStoreResult, "adapter" | "db" | "dbPath" | "cleanup" | "choice">>}
 */
export async function findAndOpenDb(from, opts) {
  const opened = await openSmithersStore({ cwd: from ?? cliWorkspace.cwd(), mode: "read", wait: opts });
  return {
    adapter: opened.adapter,
    db: opened.db,
    dbPath: opened.dbPath,
    cleanup: opened.cleanup,
    choice: opened.choice,
  };
}
