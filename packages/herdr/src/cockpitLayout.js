/**
 * Cockpit layout helpers: harness|overview 50/50 split, harness CLI detection,
 * HERDR_ENV dock mode.
 */

import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, isAbsolute } from "node:path";

/** Preferred harness binaries (first hit on PATH wins for "auto"). */
export const DEFAULT_HARNESS_CANDIDATES = ["grok", "claude", "codex", "opencode", "gemini"];

/**
 * @param {string} bin
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isExecutableOnPath(bin, env = process.env) {
  if (typeof bin !== "string" || bin === "") {
    return false;
  }
  if (isAbsolute(bin) || bin.includes("/")) {
    try {
      accessSync(bin, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathEnv = typeof env.PATH === "string" ? env.PATH : "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(`${dir}/${bin}`, fsConstants.X_OK);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

/**
 * Resolve harness argv from options + env.
 *
 * - `false` / `"none"` / `"off"` → no harness (overview-only cockpit)
 * - `string[]` → use as-is
 * - `"auto"` / `true` / undefined with chrome split → first candidate on PATH
 * - env `SMITHERS_HERDR_HARNESS` / `SMITHERS_VIBE_HARNESS` overrides (space-separated argv or "none")
 *
 * @param {{
 *   harnessCommand?: string[] | "auto" | "none" | false | true | string;
 *   candidates?: string[];
 * }} opts
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[] | null}
 */
export function resolveHarnessCommand(opts = {}, env = process.env) {
  const fromEnv =
    (typeof env.SMITHERS_HERDR_HARNESS === "string" && env.SMITHERS_HERDR_HARNESS) ||
    (typeof env.SMITHERS_VIBE_HARNESS === "string" && env.SMITHERS_VIBE_HARNESS) ||
    "";
  if (fromEnv === "none" || fromEnv === "off" || fromEnv === "0") {
    return null;
  }
  if (fromEnv) {
    const parts = fromEnv.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((p) => p.replace(/^"|"$/g, "")) ?? fromEnv.split(/\s+/);
    return parts.filter(Boolean);
  }

  const raw = opts.harnessCommand;
  if (raw === false || raw === "none" || raw === "off") {
    return null;
  }
  if (Array.isArray(raw)) {
    return raw.length > 0 ? raw.map(String) : null;
  }
  if (typeof raw === "string" && raw !== "auto" && raw !== "true") {
    if (raw === "none" || raw === "off") return null;
    return [raw];
  }
  // auto / true / undefined → detect
  if (raw === undefined) {
    return null; // caller decides whether to auto via chrome
  }
  const candidates =
    Array.isArray(opts.candidates) && opts.candidates.length > 0 ? opts.candidates : DEFAULT_HARNESS_CANDIDATES;
  for (const bin of candidates) {
    if (isExecutableOnPath(bin, env)) {
      return [bin];
    }
  }
  return null;
}

/**
 * Auto-detect first available harness on PATH.
 * @param {string[]} [candidates]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[] | null}
 */
export function detectHarnessCommand(candidates = DEFAULT_HARNESS_CANDIDATES, env = process.env) {
  return resolveHarnessCommand({ harnessCommand: "auto", candidates }, env);
}

/**
 * Whether cockpit should be a left|right split.
 *
 * @param {{
 *   chrome?: "split" | "tabs" | "auto";
 *   harnessCommand?: unknown;
 *   forceSplit?: boolean;
 * }} opts
 * @param {{ dock?: boolean; harnessArgv?: string[] | null }} ctx
 * @returns {boolean}
 */
export function shouldSplitCockpit(opts = {}, ctx = {}) {
  const chrome = opts.chrome === "split" || opts.chrome === "tabs" || opts.chrome === "auto" ? opts.chrome : "auto";
  if (chrome === "tabs") return false;
  if (chrome === "split" || opts.forceSplit === true) return true;
  // auto: split when docking into a live harness pane, or when we have a harness to spawn
  if (ctx.dock === true) return true;
  if (ctx.harnessArgv && ctx.harnessArgv.length > 0) return true;
  if (opts.harnessCommand === "auto" || opts.harnessCommand === true) {
    // Will try detect at setup time; prefer split attempt
    return true;
  }
  return false;
}

/**
 * Whether to dock into the operator's focused herdr pane (path A / ops flow).
 *
 * Enabled when:
 * - `opts.dock === true` (explicit; campaign `--ops` / surface option), or
 * - `HERDR_ENV=1` (running inside a herdr pane), or
 * - `SMITHERS_HERDR_DOCK=1` (campaign from outside, attach to focused UI pane)
 *
 * Disabled when `opts.dock === false`.
 *
 * @param {{ dock?: boolean }} opts
 * @param {NodeJS.ProcessEnv} [env]
 */
export function shouldDockIntoCurrentPane(opts = {}, env = process.env) {
  if (opts.dock === false) return false;
  if (opts.dock === true) return true;
  if (env.HERDR_ENV === "1") return true;
  if (env.SMITHERS_HERDR_DOCK === "1" || env.SMITHERS_HERDR_DOCK === "true") return true;
  return false;
}
