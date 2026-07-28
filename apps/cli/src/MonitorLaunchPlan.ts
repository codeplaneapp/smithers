/** A monitor workflow file discovered under `<packDir>/monitor/`. */
export type MonitorWorkflow = {
  /** The watched workflow's id — the monitor file is named `<workflowId>.tsx`. */
  workflowId: string;
  /** Absolute path to the monitor's `.tsx` file. */
  entryFile: string;
  /** Pack tier the monitor came from; local shadows global. */
  scope: "local" | "global";
  /** The pack directory that owns this monitor. */
  packDir: string;
};

/**
 * What a run launch should do about monitors.
 *
 * - `launch`    — start `entryFile` as a sibling monitor run.
 * - `none`      — no monitor file exists for this workflow (the common case; a
 *   workspace with zero monitor files behaves exactly as it did before).
 * - `opted-out` — `--no-monitor`.
 * - `suppressed` — the launch is itself a monitor (or an ancestor already
 *   suppressed monitors), so starting one would recurse.
 */
export type MonitorLaunchPlan =
  | { action: "launch"; monitor: MonitorWorkflow; explicit: boolean }
  | { action: "none" | "opted-out" | "suppressed"; reason: string };
