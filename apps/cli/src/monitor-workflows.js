// @smithers-type-exports-begin
/** @typedef {import("./MonitorLaunchPlan.ts").MonitorLaunchPlan} MonitorLaunchPlan */
/** @typedef {import("./MonitorLaunchPlan.ts").MonitorWorkflow} MonitorWorkflow */
// @smithers-type-exports-end

import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { SmithersError } from "@smithers-orchestrator/errors";
import { resolvePackDirs } from "./workflows.js";
import { workflowIdFromPath } from "./monitoring-suggestion.js";

/**
 * Monitor workflows.
 *
 * A monitor is an ordinary Smithers workflow that watches ONE other run. It
 * lives at `<packDir>/monitor/<workflowId>.tsx`, and when a run of
 * `<workflowId>` starts, the CLI launches it as a sibling run whose
 * `parent_run_id` is the watched run. That single link buys the whole
 * lifecycle: `ps`/`inspect`/the Gateway show the relationship, and
 * `smithers cancel` already cascades to child runs, so cancelling the watched
 * run tears its monitor down too.
 *
 * Zero monitor files means zero behavior change: discovery that finds nothing
 * is a no-op.
 */

/** Directory, inside a pack, that holds monitor workflows. */
export const MONITOR_DIR_NAME = "monitor";

/**
 * Run annotation recording which run a monitor watches. Redundant with
 * `parent_run_id` on purpose: it distinguishes a monitor from an ordinary
 * subflow child in `ps`/`inspect` output without a schema change.
 */
export const MONITOR_ANNOTATION_KEY = "smithersMonitorFor";

/**
 * Set on a monitor's own launch environment. A monitor is a workflow, so
 * without this it would discover a monitor for itself and recurse. Three
 * independent guards stop that: this env var, the `--no-monitor` flag the
 * monitor is launched with, and {@link isMonitorWorkflowFile}.
 */
export const MONITOR_SUPPRESS_ENV = "SMITHERS_MONITOR_SUPPRESS";

/**
 * Split the tri-state `--monitor` flag into the two things a launch needs.
 * `true` (the default) means auto-discover; `false` (`--no-monitor`) means opt
 * out; a string selects a monitor file explicitly. Mirrors the CLI's
 * `--resume` handling, including its `--monitor --other-flag` degenerate case,
 * where the value the parser hands back is the next flag rather than a path.
 *
 * @param {boolean | string | undefined} value
 * @returns {{ noMonitor: boolean; monitorPath: string | undefined }}
 */
export function normalizeMonitorOption(value) {
  if (value === false) return { noMonitor: true, monitorPath: undefined };
  if (value === true || value === undefined || value === null) {
    return { noMonitor: false, monitorPath: undefined };
  }
  if (typeof value !== "string") return { noMonitor: !value, monitorPath: undefined };
  const normalized = value.trim();
  if (normalized === "" || normalized === "false") return { noMonitor: true, monitorPath: undefined };
  if (normalized === "true" || normalized.startsWith("-")) return { noMonitor: false, monitorPath: undefined };
  return { noMonitor: false, monitorPath: normalized };
}

/**
 * Ordered monitor directories to search, highest precedence first: the nearest
 * local `.smithers/monitor`, then the global `~/.smithers/monitor`. Mirrors
 * `resolveWorkflowDirs`' local-then-global precedence so a monitor is found the
 * same way its workflow is.
 *
 * @param {string} [from]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ scope: "local" | "global"; dir: string; packDir: string }[]}
 */
export function resolveMonitorDirs(from = process.cwd(), env = process.env) {
  return resolvePackDirs(from, env).map(({ scope, packDir }) => ({
    scope,
    dir: join(packDir, MONITOR_DIR_NAME),
    packDir,
  }));
}

/**
 * Is this workflow file itself a monitor? True for `<packDir>/monitor/<id>.tsx`.
 * Path-shaped rather than registry-shaped so it holds for a monitor run by an
 * explicit `--monitor path/to/file.tsx` that no pack ever discovered.
 *
 * @param {string} workflowPath
 * @returns {boolean}
 */
export function isMonitorWorkflowFile(workflowPath) {
  if (!workflowPath) return false;
  return basename(dirname(resolve(workflowPath))) === MONITOR_DIR_NAME;
}

/**
 * Find the monitor that watches `workflowId`, or null when none exists.
 *
 * @param {string} workflowId
 * @param {string} [from]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {MonitorWorkflow | null}
 */
export function discoverMonitorWorkflow(workflowId, from = process.cwd(), env = process.env) {
  if (!workflowId) return null;
  for (const { scope, dir, packDir } of resolveMonitorDirs(from, env)) {
    const entryFile = join(dir, `${workflowId}.tsx`);
    try {
      if (existsSync(entryFile) && statSync(entryFile).isFile()) {
        return { workflowId, entryFile, scope, packDir };
      }
    } catch {
      // An unreadable pack dir must never be the thing that fails a launch.
    }
  }
  return null;
}

/**
 * Decide what a run launch should do about monitors. Pure apart from the
 * filesystem probe, so the whole decision table unit-tests directly.
 *
 * Precedence, highest first:
 *   1. the launch is itself a monitor, or an ancestor suppressed monitors
 *   2. `--no-monitor`
 *   3. `--monitor <path>` (must exist — a typo'd path fails loudly)
 *   4. discovery by workflow id
 *
 * @param {{
 *   workflowPath: string;
 *   monitor?: string;
 *   noMonitor?: boolean;
 *   cwd?: string;
 *   env?: NodeJS.ProcessEnv;
 * }} params
 * @returns {MonitorLaunchPlan}
 */
export function resolveMonitorLaunch(params) {
  const cwd = params.cwd ?? process.cwd();
  const env = params.env ?? process.env;
  // Recursion guards first: they must win even over an explicit --monitor, or
  // `--monitor m.tsx` on a monitor would spawn an unbounded chain.
  if (env[MONITOR_SUPPRESS_ENV]) {
    return {
      action: "suppressed",
      reason: `${MONITOR_SUPPRESS_ENV} is set: this run is (or descends from) a monitor.`,
    };
  }
  if (isMonitorWorkflowFile(params.workflowPath)) {
    return {
      action: "suppressed",
      reason: "This workflow is itself a monitor; a monitor never gets a monitor.",
    };
  }
  if (params.noMonitor) {
    return { action: "opted-out", reason: "--no-monitor" };
  }
  if (params.monitor) {
    const entryFile = isAbsolute(params.monitor) ? params.monitor : resolve(cwd, params.monitor);
    if (!existsSync(entryFile) || !statSync(entryFile).isFile()) {
      throw new SmithersError("INVALID_INPUT", `Monitor workflow not found: ${params.monitor}`, {
        monitor: params.monitor,
        resolved: entryFile,
      });
    }
    return {
      action: "launch",
      explicit: true,
      monitor: {
        workflowId: workflowIdFromPath(entryFile),
        entryFile,
        scope: "local",
        packDir: dirname(dirname(entryFile)),
      },
    };
  }
  const discovered = discoverMonitorWorkflow(workflowIdFromPath(params.workflowPath), cwd, env);
  if (!discovered) {
    return {
      action: "none",
      reason: `No .smithers/${MONITOR_DIR_NAME}/${workflowIdFromPath(params.workflowPath)}.tsx`,
    };
  }
  return { action: "launch", explicit: false, monitor: discovered };
}

/**
 * The run id a monitor gets. Derived from the watched run so relaunching a
 * monitor for the same run is detectably a duplicate rather than a silent
 * second watcher.
 *
 * @param {string} watchRunId
 * @returns {string}
 */
export function buildMonitorRunId(watchRunId) {
  return `${watchRunId}-monitor`;
}

/**
 * Argv for the detached `up` that starts a monitor. The monitor is a normal run
 * launched through the normal path. The caller already creates a detached OS
 * process, so argv must NOT request a second CLI-level detach (that would lose
 * the actual engine pid and race teardown against its late registration). It
 * is a child of the watched run
 * (`--parent-run-id`), it is told what to watch through `--input`, and it is
 * launched with `--no-monitor` so it can never spawn one of its own.
 *
 * @param {{
 *   monitorEntryFile: string;
 *   watchRunId: string;
 *   watchWorkflowId: string;
 *   watchWorkflowPath: string;
 *   monitorRunId?: string;
 *   logDir?: string;
 *   backend?: string;
 *   root?: string;
 * }} params
 * @returns {string[]}
 */
export function buildMonitorLaunchArgs(params) {
  const monitorRunId = params.monitorRunId ?? buildMonitorRunId(params.watchRunId);
  const args = [
    "up",
    params.monitorEntryFile,
    "--run-id",
    monitorRunId,
    "--parent-run-id",
    params.watchRunId,
    "--no-monitor",
    "--no-post-failure",
    "--input",
    JSON.stringify({
      watchRunId: params.watchRunId,
      watchWorkflowId: params.watchWorkflowId,
      watchWorkflowPath: params.watchWorkflowPath,
    }),
    "--annotations",
    JSON.stringify({ [MONITOR_ANNOTATION_KEY]: params.watchRunId }),
  ];
  if (params.root) args.push("--root", params.root);
  if (params.logDir) args.push("--log-dir", params.logDir);
  if (params.backend) args.push("--backend", params.backend);
  return args;
}

/**
 * Environment a monitor child is launched with: the parent's env plus the
 * suppression flag, so nothing the monitor itself launches can start a monitor
 * either.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildMonitorLaunchEnv(env = process.env) {
  return { ...env, [MONITOR_SUPPRESS_ENV]: "1" };
}
