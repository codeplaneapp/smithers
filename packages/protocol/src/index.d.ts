type DevToolsNodeType = "workflow" | "task" | "sequence" | "parallel" | "merge-queue" | "branch" | "loop" | "worktree" | "approval" | "timer" | "subflow" | "wait-for-event" | "saga" | "try-catch" | "fragment" | "unknown";

/**
 * A safe, display-only reference to one agent adapter: whitelisted string
 * fields only — never the adapter object itself (which carries callbacks,
 * options, and credentials).
 */
type DevToolsAgentRef = {
    /** Human-facing label (explicit `label`/`name`, or a non-UUID `id`). */
    label?: string;
    /** Engine tag, e.g. "claude-code" | "codex" (falls back to the adapter class name). */
    engine?: string;
    /** Declared model id, when the adapter carries one. */
    model?: string;
};
/**
 * Summary of the workflow's declared `<Task agent={...}>` assignment, captured
 * by the engine into each frame's task index at render time — so it is known
 * even for QUEUED nodes that have not executed yet. When the agent prop is a
 * failover list, the top-level fields describe the primary and `chain` lists
 * every declared entry in order.
 */
type DevToolsAgentSummary = DevToolsAgentRef & {
    chain?: DevToolsAgentRef[];
};
type DevToolsNode = {
    id: number;
    type: DevToolsNodeType;
    name: string;
    props: Record<string, unknown>;
    task?: {
        nodeId: string;
        kind: "agent" | "compute" | "static" | "human" | "approval";
        agent?: string;
        label?: string;
        outputTableName?: string;
        iteration?: number;
        /**
         * Current lifecycle state from the run's node rows (latest iteration wins),
         * e.g. "pending" | "in-progress" | "finished" | "failed" | "skipped" |
         * "waiting-approval". Absent when the node has no row yet or the snapshot
         * producer predates state enrichment.
         */
        state?: string;
        /** Last attempt number for the state-bearing iteration. */
        attempt?: number;
        /**
         * Declared agent assignment from the task index (see
         * {@link DevToolsAgentSummary}). Absent on frames recorded before agent
         * capture and on tasks with no agent prop.
         */
        agentSummary?: DevToolsAgentSummary;
        /**
         * The agent that actually executed the node's LATEST attempt, read from
         * the attempt's persisted metadata (`agentEngine` / `agentModel` /
         * `agentId`). Absent for queued nodes and attempts that predate agent
         * metadata.
         */
        agentRan?: {
            agentId?: string;
            engine?: string;
            model?: string;
        };
        /**
         * The task's initial prompt, read from the latest attempt's persisted
         * metadata (bounded to a few thousand chars — the full text stays in
         * attempt metadata). Absent for queued nodes and tasks with no prompt.
         */
        prompt?: string;
        /** Attempt budget (declared retries + 1) when finite; absent for unbounded retries. */
        maxAttempts?: number;
    };
    children: DevToolsNode[];
    depth: number;
};

type DevToolsBlockedReason = {
    kind: "approval";
    nodeId: string;
    requestedAt: string;
} | {
    kind: "event";
    nodeId: string;
    correlationKey: string;
} | {
    kind: "timer";
    nodeId: string;
    wakeAt: string;
} | {
    kind: "approval-decided-resume-required";
    nodeId: string;
} | {
    kind: "external-trigger";
} | {
    kind: "provider";
    nodeId: string;
    code: "rate-limit" | "auth" | "timeout";
} | {
    kind: "tool";
    nodeId: string;
    toolName: string;
    code: string;
} | {
    kind: "quota";
    quotaBlockedCount: number;
    resetAtMs?: number;
};
type DevToolsUnhealthyReason = {
    kind: "engine-heartbeat-stale";
    lastHeartbeatAt: string;
} | {
    kind: "timer-overdue";
    wakeAt: string;
    overdueMs: number;
} | {
    kind: "ui-heartbeat-stale";
    lastSeenAt: string;
} | {
    kind: "db-lock";
} | {
    kind: "sandbox-unreachable";
} | {
    kind: "supervisor-backoff";
    attempt: number;
    nextAt: string;
};
/**
 * Derived run state carried on DevTools snapshots. This protocol-owned wire
 * shape keeps consumers independent of the database package that computes it.
 */
type DevToolsRunState = {
    runId: string;
    state: "running" | "waiting-approval" | "waiting-event" | "waiting-timer" | "waiting-quota" | "paused" | "recovering" | "stale" | "orphaned" | "failed" | "cancelled" | "succeeded" | "unknown";
    blocked?: DevToolsBlockedReason;
    unhealthy?: DevToolsUnhealthyReason;
    computedAt: string;
};
type DevToolsSnapshot = {
    version: 1;
    runId: string;
    frameNo: number;
    seq: number;
    root: DevToolsNode;
    runState?: DevToolsRunState;
};

type DevToolsDeltaOp = {
    op: "addNode";
    parentId: number;
    index: number;
    node: DevToolsNode;
} | {
    op: "removeNode";
    id: number;
} | {
    op: "updateProps";
    id: number;
    props: Record<string, unknown>;
} | {
    op: "updateTask";
    id: number;
    task: DevToolsNode["task"];
} | {
    op: "replaceRoot";
    node: DevToolsNode;
};

type DevToolsDelta = {
    version: 1;
    baseSeq: number;
    seq: number;
    ops: DevToolsDeltaOp[];
};

type DevToolsEvent = {
    version: 1;
    kind: "snapshot";
    snapshot: DevToolsSnapshot;
} | {
    version: 1;
    kind: "delta";
    delta: DevToolsDelta;
};

/** @typedef {import("./devtools/DevToolsDelta.ts").DevToolsDelta} DevToolsDelta */
/** @typedef {import("./devtools/DevToolsDeltaOp.ts").DevToolsDeltaOp} DevToolsDeltaOp */
/** @typedef {import("./devtools/DevToolsEvent.ts").DevToolsEvent} DevToolsEvent */
/** @typedef {import("./devtools/DevToolsNode.ts").DevToolsAgentRef} DevToolsAgentRef */
/** @typedef {import("./devtools/DevToolsNode.ts").DevToolsAgentSummary} DevToolsAgentSummary */
/** @typedef {import("./devtools/DevToolsNode.ts").DevToolsNode} DevToolsNode */
/** @typedef {import("./devtools/DevToolsNodeType.ts").DevToolsNodeType} DevToolsNodeType */
/** @typedef {import("./devtools/DevToolsSnapshot.ts").DevToolsRunState} DevToolsRunState */
/** @typedef {import("./devtools/DevToolsSnapshot.ts").DevToolsSnapshot} DevToolsSnapshot */
declare const DEVTOOLS_PROTOCOL_VERSION: 1;

type NodeOutputErrorCode = "InvalidRunId" | "InvalidNodeId" | "InvalidIteration" | "RunNotFound" | "NodeNotFound" | "IterationNotFound" | "NodeHasNoOutput" | "SchemaConversionError" | "MalformedOutputRow" | "PayloadTooLarge";

type NodeDiffErrorCode = "InvalidRunId" | "InvalidNodeId" | "InvalidIteration" | "RunNotFound" | "NodeNotFound" | "AttemptNotFound" | "AttemptNotFinished" | "VcsError" | "WorkingTreeDirty" | "DiffTooLarge";

type JumpToFrameErrorCode = "InvalidRunId" | "InvalidFrameNo" | "RunNotFound" | "FrameOutOfRange" | "ConfirmationRequired" | "Busy" | "UnsupportedSandbox" | "VcsError" | "RewindFailed" | "RateLimited" | "Unauthorized";

type DevToolsErrorCode = "RunNotFound" | "InvalidRunId" | "FrameOutOfRange" | "SeqOutOfRange" | "BackpressureDisconnect" | "Unauthorized" | "InvalidDelta";

/** @typedef {import("./DevToolsErrorCode.ts").DevToolsErrorCode} DevToolsErrorCode */
/** @typedef {import("./JumpToFrameErrorCode.ts").JumpToFrameErrorCode} JumpToFrameErrorCode */
/** @typedef {import("./NodeDiffErrorCode.ts").NodeDiffErrorCode} NodeDiffErrorCode */
/** @typedef {import("./NodeOutputErrorCode.ts").NodeOutputErrorCode} NodeOutputErrorCode */
declare const DEVTOOLS_ERROR_CODES: readonly ["RunNotFound", "InvalidRunId", "FrameOutOfRange", "SeqOutOfRange", "BackpressureDisconnect", "Unauthorized", "InvalidDelta"];
declare const NODE_OUTPUT_ERROR_CODES: readonly ["InvalidRunId", "InvalidNodeId", "InvalidIteration", "RunNotFound", "NodeNotFound", "IterationNotFound", "NodeHasNoOutput", "SchemaConversionError", "MalformedOutputRow", "PayloadTooLarge"];
declare const NODE_DIFF_ERROR_CODES: readonly ["InvalidRunId", "InvalidNodeId", "InvalidIteration", "RunNotFound", "NodeNotFound", "AttemptNotFound", "AttemptNotFinished", "VcsError", "WorkingTreeDirty", "DiffTooLarge"];
declare const JUMP_TO_FRAME_ERROR_CODES: readonly ["InvalidRunId", "InvalidFrameNo", "RunNotFound", "FrameOutOfRange", "ConfirmationRequired", "Busy", "UnsupportedSandbox", "VcsError", "RewindFailed", "RateLimited", "Unauthorized"];

export { DEVTOOLS_ERROR_CODES, DEVTOOLS_PROTOCOL_VERSION, type DevToolsAgentRef, type DevToolsAgentSummary, type DevToolsDelta, type DevToolsDeltaOp, type DevToolsErrorCode, type DevToolsEvent, type DevToolsNode, type DevToolsNodeType, type DevToolsRunState, type DevToolsSnapshot, JUMP_TO_FRAME_ERROR_CODES, type JumpToFrameErrorCode, NODE_DIFF_ERROR_CODES, NODE_OUTPUT_ERROR_CODES, type NodeDiffErrorCode, type NodeOutputErrorCode };
