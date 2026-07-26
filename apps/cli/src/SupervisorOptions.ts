import type { SmithersDb } from "@smithers-orchestrator/db/adapter";

export type SupervisorSpawnClaim = {
  claimOwnerId: string;
  claimHeartbeatAtMs: number;
  restoreRuntimeOwnerId?: string | null;
  restoreHeartbeatAtMs?: number | null;
};

export type SupervisorDeps = {
  now: () => number;
  workflowExists: (workflowPath: string) => boolean;
  parseRuntimeOwnerPid: (runtimeOwnerId: string | null | undefined) => number | null;
  isPidAlive: (pid: number) => boolean;
  spawnResumeDetached: (workflowPath: string, runId: string, claim?: SupervisorSpawnClaim) => number | null;
  runsDueForQuotaResume: (adapter: SmithersDb, nowMs: number) => Promise<any[]>;
  /** Best-effort tail of a detached resume log, for give-up diagnostics. */
  readDetachedLogTail: (logFile: string) => string | null;
};

export type SupervisorOptions = {
  adapter: SmithersDb;
  /** When present, supervision is restricted to these exact run IDs. */
  runIds?: readonly string[];
  pollIntervalMs?: number;
  staleThresholdMs?: number;
  maxConcurrent?: number;
  /**
   * Consecutive auto-resume attempts that die before the resumed engine
   * activates before the supervisor gives up and fails the run. Default 3.
   */
  maxResumeAttempts?: number;
  dryRun?: boolean;
  supervisorId?: string;
  supervisorRunId?: string;
  deps?: Partial<SupervisorDeps>;
};
