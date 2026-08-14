/**
 * @param {string} bin
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
declare function isExecutableOnPath(bin: string, env?: NodeJS.ProcessEnv): boolean;
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
declare function resolveHarnessCommand(opts?: {
    harnessCommand?: string[] | "auto" | "none" | false | true | string;
    candidates?: string[];
}, env?: NodeJS.ProcessEnv): string[] | null;
/**
 * Auto-detect first available harness on PATH.
 * @param {string[]} [candidates]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[] | null}
 */
declare function detectHarnessCommand(candidates?: string[], env?: NodeJS.ProcessEnv): string[] | null;
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
declare function shouldSplitCockpit(opts?: {
    chrome?: "split" | "tabs" | "auto";
    harnessCommand?: unknown;
    forceSplit?: boolean;
}, ctx?: {
    dock?: boolean;
    harnessArgv?: string[] | null;
}): boolean;
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
declare function shouldDockIntoCurrentPane(opts?: {
    dock?: boolean;
}, env?: NodeJS.ProcessEnv): boolean;
/** Preferred harness binaries (first hit on PATH wins for "auto"). */
declare const DEFAULT_HARNESS_CANDIDATES: string[];

export { DEFAULT_HARNESS_CANDIDATES, detectHarnessCommand, isExecutableOnPath, resolveHarnessCommand, shouldDockIntoCurrentPane, shouldSplitCockpit };
