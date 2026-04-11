export type JsonRecord = Record<string, unknown>;
export type OutputKey = Record<string, string | number | boolean | null>;

export type Run = {
  readonly runId: string;
  readonly parentRunId?: string | null;
  readonly workflowName?: string | null;
  readonly workflowPath?: string | null;
  readonly workflowHash?: string | null;
  readonly status: string;
  readonly createdAtMs?: number;
  readonly startedAtMs?: number | null;
  readonly finishedAtMs?: number | null;
  readonly heartbeatAtMs?: number | null;
  readonly runtimeOwnerId?: string | null;
  readonly cancelRequestedAtMs?: number | null;
  readonly hijackRequestedAtMs?: number | null;
  readonly hijackTarget?: string | null;
  readonly vcsType?: string | null;
  readonly vcsRoot?: string | null;
  readonly vcsRevision?: string | null;
  readonly errorJson?: string | null;
  readonly configJson?: string | null;
};

export type RunRow = Run;
export type RunPatch = Partial<Omit<Run, "runId">>;

export const DB_RUN_ALLOWED_STATUSES = [
  "running",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "finished",
  "failed",
  "cancelled",
  "continued",
] as const;

export type StaleRunRecord = Pick<
  Run,
  "runId" | "workflowPath" | "heartbeatAtMs" | "runtimeOwnerId" | "status"
>;

export type RunAncestryRow = {
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly depth: number;
};

export type EventHistoryQuery = {
  readonly afterSeq?: number;
  readonly limit?: number;
  readonly nodeId?: string;
  readonly types?: readonly string[];
  readonly sinceTimestampMs?: number;
};

export type SignalQuery = {
  readonly signalName?: string;
  readonly correlationId?: string | null;
  readonly receivedAfterMs?: number;
  readonly limit?: number;
};

export type FrameRow = {
  readonly runId: string;
  readonly frameNo: number;
  readonly xmlJson?: string | null;
  readonly graphJson?: string | null;
  readonly xmlHash?: string | null;
  readonly xmlEncoding?: string | null;
  readonly createdAtMs?: number;
  readonly [key: string]: unknown;
};

export type NodeRow = {
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly state: string;
  readonly lastAttempt?: number | null;
  readonly updatedAtMs: number;
  readonly outputTable?: string;
  readonly label?: string | null;
};

export type AttemptRow = {
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly attempt: number;
  readonly state: string;
  readonly startedAtMs: number;
  readonly finishedAtMs?: number | null;
  readonly heartbeatAtMs?: number | null;
  readonly heartbeatDataJson?: string | null;
  readonly errorJson?: string | null;
  readonly jjPointer?: string | null;
  readonly responseText?: string | null;
  readonly jjCwd?: string | null;
  readonly cached?: boolean;
  readonly metaJson?: string | null;
};

export type Attempt = AttemptRow;

export type AttemptPatch = Partial<
  Omit<AttemptRow, "runId" | "nodeId" | "iteration" | "attempt">
>;

export type ApprovalRow = {
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly status: string;
  readonly requestedAtMs?: number | null;
  readonly decidedAtMs?: number | null;
  readonly note?: string | null;
  readonly decidedBy?: string | null;
  readonly requestJson?: string | null;
  readonly decisionJson?: string | null;
  readonly autoApproved?: boolean;
};

export type HumanRequestStatus =
  | "pending"
  | "answered"
  | "cancelled"
  | "expired";

export type HumanRequestKind = "approval" | "input" | "review" | (string & {});

export type HumanRequestRow = {
  readonly requestId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly kind: HumanRequestKind;
  readonly status: HumanRequestStatus;
  readonly prompt: string;
  readonly schemaJson?: string | null;
  readonly optionsJson?: string | null;
  readonly responseJson?: string | null;
  readonly requestedAtMs: number;
  readonly answeredAtMs?: number | null;
  readonly answeredBy?: string | null;
  readonly timeoutAtMs?: number | null;
};

export type PendingHumanRequestRow = HumanRequestRow & {
  readonly workflowName?: string | null;
  readonly runStatus?: string | null;
  readonly nodeLabel?: string | null;
};

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertStatus = "firing" | "acknowledged" | "resolved" | "silenced";

export const DB_ALERT_ALLOWED_SEVERITIES = [
  "info",
  "warning",
  "critical",
] as const;
export const DB_ALERT_ALLOWED_STATUSES = [
  "firing",
  "acknowledged",
  "resolved",
  "silenced",
] as const;

export type AlertRow = {
  readonly alertId: string;
  readonly runId?: string | null;
  readonly policyName: string;
  readonly severity: AlertSeverity;
  readonly status: AlertStatus;
  readonly firedAtMs: number;
  readonly resolvedAtMs?: number | null;
  readonly acknowledgedAtMs?: number | null;
  readonly message: string;
  readonly detailsJson?: string | null;
};

export type SignalRow = {
  readonly runId: string;
  readonly seq: number;
  readonly signalName: string;
  readonly correlationId: string | null;
  readonly payloadJson: string;
  readonly receivedAtMs: number;
  readonly receivedBy?: string | null;
};

export type SignalInsertRow = Omit<SignalRow, "seq">;

export type EventRow = {
  readonly runId: string;
  readonly seq: number;
  readonly timestampMs: number;
  readonly type: string;
  readonly payloadJson: string;
};

export type EventInsertRow = Omit<EventRow, "seq">;

export type CacheRow = {
  readonly cacheKey: string;
  readonly createdAtMs: number;
  readonly workflowName: string;
  readonly nodeId: string;
  readonly outputTable: string;
  readonly schemaSig: string;
  readonly agentSig?: string | null;
  readonly toolsSig?: string | null;
  readonly jjPointer?: string | null;
  readonly payloadJson: string;
};

export type RalphRow = {
  readonly runId: string;
  readonly ralphId: string;
  readonly iteration: number;
  readonly done?: boolean;
  readonly stateJson?: string | null;
  readonly updatedAtMs?: number;
};

export type SandboxRow = {
  readonly runId: string;
  readonly sandboxId: string;
  readonly [key: string]: unknown;
};

export type ToolCallRow = {
  readonly runId: string;
  readonly nodeId: string;
  readonly iteration: number;
  readonly [key: string]: unknown;
};

export type CronRow = {
  readonly cronId: string;
  readonly pattern?: string;
  readonly workflowPath?: string;
  readonly enabled?: boolean;
  readonly lastRunAtMs?: number | null;
  readonly nextRunAtMs?: number | null;
  readonly errorJson?: string | null;
  readonly [key: string]: unknown;
};

export type ScorerResultRow = {
  readonly runId: string;
  readonly nodeId?: string;
  readonly scorerId?: string;
  readonly scoredAtMs?: number;
  readonly [key: string]: unknown;
};

export type ClaimRunForResumeParams = {
  readonly runId: string;
  readonly expectedStatus?: string;
  readonly expectedRuntimeOwnerId: string | null;
  readonly expectedHeartbeatAtMs: number | null;
  readonly staleBeforeMs: number;
  readonly claimOwnerId: string;
  readonly claimHeartbeatAtMs: number;
  readonly requireStale?: boolean;
};

export type ReleaseRunResumeClaimParams = {
  readonly runId: string;
  readonly claimOwnerId: string;
  readonly restoreRuntimeOwnerId: string | null;
  readonly restoreHeartbeatAtMs: number | null;
};

export type UpdateClaimedRunParams = {
  readonly runId: string;
  readonly expectedRuntimeOwnerId: string;
  readonly expectedHeartbeatAtMs: number | null;
  readonly patch: RunPatch;
};
