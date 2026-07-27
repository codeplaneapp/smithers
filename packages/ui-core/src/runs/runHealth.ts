/**
 * Native port of the Smithers Monitor's run-health verdict, ported verbatim
 * from multi's `src/runs/runHealth.ts` (monitorModel `diagnoseRun` healthState
 * branch + HealthStrip). The honest source is the engine-computed gateway
 * `runState.state` — DISTINCT from the run's lifecycle status. Health is
 * surfaced only when it DIVERGES from the status; missing data is unknown (no
 * UI), never green. We never infer health from timestamps.
 */

/** The engine heartbeat states the gateway reports as a health divergence. */
export type RunHealthState = "stale" | "orphaned" | "recovering";

const HEALTH_STATES: readonly RunHealthState[] = ["stale", "orphaned", "recovering"];

function isHealthState(value: unknown): value is RunHealthState {
  return typeof value === "string" && (HEALTH_STATES as readonly string[]).includes(value);
}

/**
 * Read the engine-computed `runState.state` off a raw gateway snapshot, keeping
 * ONLY a health-divergence value (stale/orphaned/recovering). A normal
 * lifecycle state (running/…) or a missing payload is `undefined` — unknown, not
 * green. This is the same field `syncGatewayRunTree` reads for run status.
 */
export function snapshotHealthState(snapshot: unknown): RunHealthState | undefined {
  if (snapshot === null || typeof snapshot !== "object") return undefined;
  const runState = (snapshot as { runState?: unknown }).runState;
  if (runState === null || typeof runState !== "object") return undefined;
  const state = (runState as { state?: unknown }).state;
  return isHealthState(state) ? state : undefined;
}

export type RunHealth = {
  state: RunHealthState;
  /** Existing banner tone class: failed for stale/orphaned, waiting for recovering. */
  tone: "tone-failed" | "tone-waiting";
  /** Only stale/orphaned claim a one-click resume; recovering is already re-attaching. */
  canResume: boolean;
  headline: string;
};

/**
 * The banner verdict. Returns `null` (no UI) unless `healthState` is a genuine
 * health value that DIVERGES from the run's lifecycle status. A run whose engine
 * already reports the same state as its status is not a divergence.
 */
export function runHealth(
  healthState: string | undefined,
  runStatus: string | undefined,
): RunHealth | null {
  if (!isHealthState(healthState)) return null;
  if (healthState === runStatus) return null;
  if (healthState === "recovering") {
    return {
      state: "recovering",
      tone: "tone-waiting",
      canResume: false,
      headline: "Engine is re-attaching to this run",
    };
  }
  return {
    state: healthState,
    tone: "tone-failed",
    canResume: true,
    headline:
      healthState === "orphaned"
        ? "Engine dropped this run — resume to re-attach"
        : "Engine heartbeat is stale — resume to re-attach",
  };
}
