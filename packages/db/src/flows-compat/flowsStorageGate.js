/**
 * The gate that decides whether a workspace runs the flows-backed storage path.
 *
 * Stage 1.1 of `.smithers/specs/flows-migration.md` ships default-off. Stage 0.4
 * decided that flows storage is SQLite-only: flows ships one SQL backend, so a
 * PGlite or Postgres workspace keeps the legacy `adapter.js` path until flows
 * lands its `pg`/`pglite` layers.
 */
import { POSTGRES } from "../dialect.js";

/** Opt-in switch. Also honours `SMITHERS_ENGINE=flows`. */
export const FLOWS_STORAGE_ENV_VAR = "SMITHERS_FLOWS_STORAGE";
/** The engine selector stage 1.3 routes on. */
export const SMITHERS_ENGINE_ENV_VAR = "SMITHERS_ENGINE";

const TRUTHY = new Set(["1", "true", "on", "yes", "enabled"]);
const FALSY = new Set(["0", "false", "off", "no", "disabled"]);

/**
 * @param {unknown} value
 * @returns {boolean | null} `null` when the value says nothing either way.
 */
function parseFlag(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) return null;
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return null;
}

/**
 * @param {string | null | undefined} filename
 * @returns {boolean}
 */
function isSharableSqliteFile(filename) {
  if (typeof filename !== "string") return false;
  const trimmed = filename.trim();
  if (trimmed.length === 0) return false;
  // An in-memory database is private to the connection that opened it, so a
  // second connection — which is how the flows stores reach this database —
  // would see an empty file instead of the workspace.
  if (trimmed === ":memory:") return false;
  if (trimmed.startsWith("file::memory:")) return false;
  if (trimmed.includes("mode=memory")) return false;
  return true;
}

/**
 * Decide whether this database may run the flows-backed storage path.
 *
 * @param {{ dialect?: string | undefined; driverKind?: string | undefined; filename?: string | null | undefined; env?: Record<string, string | undefined> }} params
 * @returns {{ enabled: boolean; reason: "enabled" | "not-requested" | "explicitly-disabled" | "non-sqlite-workspace" | "unsupported-sqlite-driver" | "in-memory-database" }}
 */
export function resolveFlowsStorageDecision(params) {
  const env = params.env ?? process.env;
  const explicit = parseFlag(env[FLOWS_STORAGE_ENV_VAR]);
  if (explicit === false) return { enabled: false, reason: "explicitly-disabled" };
  const requested = explicit === true || env[SMITHERS_ENGINE_ENV_VAR]?.trim().toLowerCase() === "flows";
  if (!requested) return { enabled: false, reason: "not-requested" };
  if (params.dialect === POSTGRES) return { enabled: false, reason: "non-sqlite-workspace" };
  if (params.driverKind !== "bun-sqlite") return { enabled: false, reason: "unsupported-sqlite-driver" };
  if (!isSharableSqliteFile(params.filename)) return { enabled: false, reason: "in-memory-database" };
  return { enabled: true, reason: "enabled" };
}
