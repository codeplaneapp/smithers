type DevToolsNodeType = "workflow" | "task" | "sequence" | "parallel" | "merge-queue" | "branch" | "loop" | "worktree" | "approval" | "timer" | "subflow" | "wait-for-event" | "saga" | "try-catch" | "fragment" | "unknown";

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
    };
    children: DevToolsNode[];
    depth: number;
};

type DevToolsSnapshot = {
    version: 1;
    runId: string;
    frameNo: number;
    seq: number;
    root: DevToolsNode;
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
/** @typedef {import("./devtools/DevToolsNode.ts").DevToolsNode} DevToolsNode */
/** @typedef {import("./devtools/DevToolsNodeType.ts").DevToolsNodeType} DevToolsNodeType */
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

export { DEVTOOLS_ERROR_CODES, DEVTOOLS_PROTOCOL_VERSION, type DevToolsDelta, type DevToolsDeltaOp, type DevToolsErrorCode, type DevToolsEvent, type DevToolsNode, type DevToolsNodeType, type DevToolsSnapshot, JUMP_TO_FRAME_ERROR_CODES, type JumpToFrameErrorCode, NODE_DIFF_ERROR_CODES, NODE_OUTPUT_ERROR_CODES, type NodeDiffErrorCode, type NodeOutputErrorCode };
