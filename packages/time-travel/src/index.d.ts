import * as _smithers_orchestrator_observability_SmithersEvent from '@smithers-orchestrator/observability/SmithersEvent';
import { SmithersEvent as SmithersEvent$1 } from '@smithers-orchestrator/observability/SmithersEvent';
import * as _smithers_orchestrator_db_adapter from '@smithers-orchestrator/db/adapter';
import { SmithersDb as SmithersDb$g } from '@smithers-orchestrator/db/adapter';
export { replaysStarted, runForksCreated, snapshotDuration, snapshotsCaptured } from '@smithers-orchestrator/observability/metrics';
import * as drizzle_orm_sqlite_core from 'drizzle-orm/sqlite-core';

type CrossedEffect$1 = {
    runId: string;
    kind: "tool" | "task";
    toolName: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    seq: number;
    effectStatus: "succeeded" | "unknown";
    idempotent: boolean;
    hasRevert: boolean;
    startedAtMs: number;
    reason?: string;
};

type EffectBoundaryReport$4 = {
    blocking: CrossedEffect$1[];
    revertible: CrossedEffect$1[];
    warnings: CrossedEffect$1[];
};

type EffectBoundaryAttempt = {
    nodeId: string;
    iteration: number;
    attempt: number;
};

type EffectBoundaryToolMetadata = {
    name: string;
    sideEffect: boolean;
    idempotent: boolean;
    hasRevert?: boolean;
};

type EffectBoundaryParams$2 = {
    runId: string;
    cutoffMs?: number;
    attempts?: readonly EffectBoundaryAttempt[];
    toolMetadata?: ReadonlyMap<string, EffectBoundaryToolMetadata>;
};

type TimeTravelResult$2 = {
    success: boolean;
    jjPointer?: string;
    vcsRestored: boolean;
    resetNodes: string[];
    error?: string;
    effectBoundary: EffectBoundaryReport$4;
};

type TimeTravelOptions$2 = {
    runId: string;
    nodeId: string;
    iteration?: number;
    attempt?: number;
    resetDependents?: boolean;
    restoreVcs?: boolean;
    force?: boolean;
    noRevert?: boolean;
    caller?: string;
    onProgress?: (event: SmithersEvent$1) => void;
    hooks?: {
        afterEffectReverts?: () => Promise<void> | void;
    };
};

type RevertResult$2 = {
    success: boolean;
    error?: string;
    jjPointer?: string;
    effectBoundary: EffectBoundaryReport$4;
};

type RevertOptions$2 = {
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    force?: boolean;
    noRevert?: boolean;
    caller?: string;
    onProgress?: (event: SmithersEvent$1) => void;
    hooks?: {
        afterEffectReverts?: () => Promise<void> | void;
    };
};

type RewindAuditResult$4 = "success" | "failed" | "partial" | "in_progress"
/** Refused before any mutation (Busy/RateLimited); never counts against the quota. */
 | "rejected";

type RewindLockHandle$2 = {
    runId: string;
    ownerToken: string;
    readonly expiresAtMs: number;
    renew: () => Promise<boolean>;
    checkStillHeld: () => Promise<boolean>;
    release: () => Promise<boolean>;
};

type JumpStepName$1 = "snapshot-pre-jump" | "pause-event-loop" | "revert-effects" | "revert-sandboxes" | "truncate-frames" | "truncate-attempts" | "truncate-outputs" | "invalidate-diffs" | "rebuild-reconciler" | "resume-event-loop";

type JumpToFrameInput$2 = {
    adapter: SmithersDb$g;
    runId: unknown;
    frameNo: unknown;
    confirm?: unknown;
    caller?: string;
    /** Bypass the live-run guard (rewind a run that still looks actively driven). */
    force?: unknown;
    /** Skip registered compensation handlers; crossed effects then require force. */
    noRevert?: unknown;
    pauseRunLoop?: () => Promise<void> | void;
    resumeRunLoop?: () => Promise<void> | void;
    captureReconcilerState?: () => Promise<unknown> | unknown;
    restoreReconcilerState?: (snapshot: unknown) => Promise<void> | void;
    rebuildReconcilerState?: (xmlJson: string) => Promise<void> | void;
    emitEvent?: (event: SmithersEvent$1) => Promise<void> | void;
    getCurrentPointerImpl?: (cwd?: string) => Promise<string | null>;
    revertToPointerImpl?: (pointer: string, cwd?: string) => Promise<{
        success: boolean;
        error?: string;
    }>;
    nowMs?: () => number;
    rateLimit?: {
        maxPerWindow?: number;
        windowMs?: number;
    };
    hooks?: {
        beforeStep?: (step: JumpStepName$1) => Promise<void> | void;
        afterStep?: (step: JumpStepName$1) => Promise<void> | void;
    };
    onLog?: (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => Promise<void> | void;
};

type JumpResult$2 = {
    ok: true;
    newFrameNo: number;
    revertedSandboxes: number;
    deletedFrames: number;
    deletedAttempts: number;
    invalidatedDiffs: number;
    durationMs: number;
    effectBoundary: EffectBoundaryReport$4;
};

type VcsTag$2 = {
    runId: string;
    frameNo: number;
    vcsType: string;
    vcsPointer: string;
    vcsRoot: string | null;
    jjOperationId: string | null;
    createdAtMs: number;
};

/**
 * Branch metadata.
 */
type BranchInfo$2 = {
    runId: string;
    parentRunId: string;
    parentFrameNo: number;
    branchLabel: string | null;
    forkDescription: string | null;
    createdAtMs: number;
};

/**
 * Timeline entry for a single frame in a run.
 */
type TimelineFrame$1 = {
    frameNo: number;
    createdAtMs: number;
    contentHash: string;
    forkPoints: BranchInfo$2[];
};

/**
 * Timeline for a single run.
 */
type RunTimeline$2 = {
    runId: string;
    frames: TimelineFrame$1[];
    branch: BranchInfo$2 | null;
    /** Durable operator controls that affect oneshot execution between frames. */
    controls?: Array<{
        seq: number;
        type: string;
        timestampMs: number;
        payload: Record<string, unknown>;
    }>;
};

/**
 * Recursive timeline tree including forks.
 */
type TimelineTree$4 = {
    timeline: RunTimeline$2;
    children: TimelineTree$4[];
};

type NodeSnapshot$1 = {
    nodeId: string;
    iteration: number;
    state: string;
    lastAttempt: number | null;
    outputTable: string;
    label: string | null;
};

type NodeChange$1 = {
    nodeId: string;
    from: NodeSnapshot$1;
    to: NodeSnapshot$1;
};

type OutputChange$1 = {
    key: string;
    from: unknown;
    to: unknown;
};

type RalphSnapshot$1 = {
    ralphId: string;
    iteration: number;
    done: boolean;
};

type RalphChange$1 = {
    ralphId: string;
    from: RalphSnapshot$1;
    to: RalphSnapshot$1;
};

/**
 * Structured diff between two snapshots.
 */
type SnapshotDiff$2 = {
    nodesAdded: string[];
    nodesRemoved: string[];
    nodesChanged: NodeChange$1[];
    outputsAdded: string[];
    outputsRemoved: string[];
    outputsChanged: OutputChange$1[];
    ralphAdded: string[];
    ralphRemoved: string[];
    ralphChanged: RalphChange$1[];
    inputChanged: boolean;
    vcsPointerChanged: boolean;
};

type SnapshotData$2 = {
    nodes: Array<{
        nodeId: string;
        iteration: number;
        state: string;
        lastAttempt: number | null;
        outputTable: string;
        label: string | null;
    }>;
    outputs: Record<string, unknown>;
    ralph: Array<{
        ralphId: string;
        iteration: number;
        done: boolean;
    }>;
    input: Record<string, unknown>;
    vcsPointer?: string | null;
    workflowHash?: string | null;
};

/**
 * Serialized snapshot of workflow state at a specific frame.
 */
type Snapshot$5 = {
    runId: string;
    frameNo: number;
    nodesJson: string;
    outputsJson: string;
    ralphJson: string;
    inputJson: string;
    vcsPointer: string | null;
    workflowHash: string | null;
    contentHash: string;
    createdAtMs: number;
};

type ReplayResult$2 = {
    runId: string;
    branch: BranchInfo$2;
    snapshot: Snapshot$5;
    vcsRestored: boolean;
    vcsPointer: string | null;
    vcsError?: string;
    effectBoundary: EffectBoundaryReport$4;
};

/**
 * Parameters for replaying from a checkpoint.
 */
type ReplayParams$2 = {
    parentRunId: string;
    frameNo: number;
    inputOverrides?: Record<string, unknown>;
    resetNodes?: string[];
    branchLabel?: string;
    restoreVcs?: boolean;
    cwd?: string;
    /**
     * Re-bless the forked run's durable workflow metadata to the workflow being
     * replayed. Without these, the fork inherits the PARENT's hashes and the
     * resume guard (assertResumeDurabilityMetadata) rejects a replay whose
     * workflow source was edited — defeating the "carry the edit forward" purpose
     * of replay. The CLI computes these from the resolved workflow file (mirrors
     * the `fork` command); omit them to keep the parent's metadata unchanged.
     */
    workflowPath?: string;
    workflowHash?: string | null;
    entryWorkflowHash?: string | null;
    force?: boolean;
};

/**
 * Parsed snapshot data for diffing and display.
 */
type ParsedSnapshot$3 = {
    runId: string;
    frameNo: number;
    nodes: Record<string, NodeSnapshot$1>;
    outputs: Record<string, unknown>;
    ralph: Record<string, RalphSnapshot$1>;
    input: Record<string, unknown>;
    vcsPointer: string | null;
    workflowHash: string | null;
    contentHash: string;
    createdAtMs: number;
};

/**
 * Parameters for forking a run.
 */
type ForkParams$2 = {
    parentRunId: string;
    frameNo: number;
    inputOverrides?: Record<string, unknown>;
    resetNodes?: string[];
    branchLabel?: string;
    forkDescription?: string;
    workflowPath?: string | null;
    workflowHash?: string | null;
    entryWorkflowHash?: string | null;
    force?: boolean;
    /** True when the caller will immediately resume the child. */
    autoRun?: boolean;
    /** Internal operation label used by replay. */
    operation?: "fork" | "replay";
};

/**
 * @param {SmithersDb} adapter
 * @param {RevertOptions} opts
 * @returns {Promise<RevertResult>}
 */
declare function revertToAttempt(adapter: SmithersDb$f, opts: RevertOptions$1): Promise<RevertResult$1>;
type RevertOptions$1 = RevertOptions$2;
type RevertResult$1 = RevertResult$2;
type SmithersDb$f = _smithers_orchestrator_db_adapter.SmithersDb;

/**
 * @param {SmithersDb} adapter
 * @param {TimeTravelOptions} opts
 * @returns {Promise<TimeTravelResult>}
 */
declare function timeTravel(adapter: SmithersDb$e, opts: TimeTravelOptions$1): Promise<TimeTravelResult$1>;
type SmithersDb$e = _smithers_orchestrator_db_adapter.SmithersDb;
type TimeTravelOptions$1 = TimeTravelOptions$2;
type TimeTravelResult$1 = TimeTravelResult$2;

/**
 * Assess the external effects crossed by a destructive or branching
 * time-travel boundary. This function only classifies; callers decide whether
 * to compensate, block, warn, or force the crossing.
 *
 * @param {SmithersDb} db
 * @param {EffectBoundaryParams} params
 * @returns {Promise<EffectBoundaryReport>}
 */
declare function assessEffectBoundary(db: SmithersDb$d, params: EffectBoundaryParams$1): Promise<EffectBoundaryReport$3>;
type SmithersDb$d = _smithers_orchestrator_db_adapter.SmithersDb;
type EffectBoundaryParams$1 = EffectBoundaryParams$2;
type EffectBoundaryReport$3 = EffectBoundaryReport$4;

type EffectTaskHandler = {
    revert?: (context: Record<string, unknown>) => Promise<void>;
};

type EffectToolHandler = EffectBoundaryToolMetadata & {
    revert?: (input: unknown, context: Record<string, unknown>) => Promise<void>;
};

type EffectHandlerRegistry$1 = {
    toolMetadata: ReadonlyMap<string, EffectBoundaryToolMetadata>;
    tools: ReadonlyMap<string, EffectToolHandler>;
    tasks: ReadonlyMap<string, EffectTaskHandler>;
};

/**
 * Run resolved compensation handlers in reverse chronological order. Each
 * effect row is journaled before and after its handler. A failure aborts with
 * the boundary report and leaves all history intact.
 *
 * @param {SmithersDb} db
 * @param {{
 *   runId: string;
 *   operation: string;
 *   report: EffectBoundaryReport;
 *   registry: EffectHandlerRegistry;
 *   checkStillHeld?: () => Promise<boolean>;
 *   onProgress?: (event: SmithersEvent) => void;
 * }} params
 * @returns {Promise<EffectBoundaryReport>}
 */
declare function executeEffectReverts(db: SmithersDb$c, params: {
    runId: string;
    operation: string;
    report: EffectBoundaryReport$2;
    registry: EffectHandlerRegistry;
    checkStillHeld?: () => Promise<boolean>;
    onProgress?: (event: SmithersEvent) => void;
}): Promise<EffectBoundaryReport$2>;
type SmithersDb$c = _smithers_orchestrator_db_adapter.SmithersDb;
type SmithersEvent = _smithers_orchestrator_observability_SmithersEvent.SmithersEvent;
type EffectBoundaryReport$2 = EffectBoundaryReport$4;
type EffectHandlerRegistry = EffectHandlerRegistry$1;

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./ReplayParams.ts").ReplayParams} ReplayParams */
/**
 * Fork a run from a checkpoint and optionally restore the VCS working copy.
 *
 * @param {SmithersDb} adapter
 * @param {ReplayParams} params
 * @returns {Promise<ReplayResult>}
 */
declare function replayFromCheckpoint(adapter: SmithersDb$b, params: ReplayParams$1): Promise<ReplayResult$1>;

type SmithersDb$b = _smithers_orchestrator_db_adapter.SmithersDb;
type ReplayParams$1 = ReplayParams$2;
type ReplayResult$1 = ReplayResult$2;

/**
 * @param {Snapshot} snapshot
 * @returns {ParsedSnapshot}
 */
declare function parseSnapshot(snapshot: Snapshot$4): ParsedSnapshot$2;
type ParsedSnapshot$2 = ParsedSnapshot$3;
type Snapshot$4 = Snapshot$5;

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/**
 * Capture a snapshot row for a run at a given frame.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @param {SnapshotData} data
 * @returns {Promise<Snapshot>}
 */
declare function captureSnapshot(adapter: SmithersDb$a, runId: string, frameNo: number, data: SnapshotData$1): Promise<Snapshot$3>;
/**
 * Load a specific snapshot row for a run/frame.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @returns {Promise<Snapshot | undefined>}
 */
declare function loadSnapshot(adapter: SmithersDb$a, runId: string, frameNo: number): Promise<Snapshot$3 | undefined>;
/**
 * Load the most recent snapshot row for a run.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<Snapshot | undefined>}
 */
declare function loadLatestSnapshot(adapter: SmithersDb$a, runId: string): Promise<Snapshot$3 | undefined>;
/**
 * List lightweight snapshot index rows for a run.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<Array<Pick<Snapshot, "runId" | "frameNo" | "contentHash" | "createdAtMs" | "vcsPointer">>>}
 */
declare function listSnapshots(adapter: SmithersDb$a, runId: string): Promise<Array<Pick<Snapshot$3, "runId" | "frameNo" | "contentHash" | "createdAtMs" | "vcsPointer">>>;

type SmithersDb$a = _smithers_orchestrator_db_adapter.SmithersDb;
type Snapshot$3 = Snapshot$5;
type SnapshotData$1 = SnapshotData$2;

/** @typedef {import("./ParsedSnapshot.ts").ParsedSnapshot} ParsedSnapshot */
/** @typedef {import("./snapshot/Snapshot.ts").Snapshot} Snapshot */
/** @typedef {import("./SnapshotDiff.ts").SnapshotDiff} SnapshotDiff */
/**
 * Compute a structured diff between two parsed snapshots.
 *
 * @param {ParsedSnapshot} a
 * @param {ParsedSnapshot} b
 * @returns {SnapshotDiff}
 */
declare function diffSnapshots(a: ParsedSnapshot$1, b: ParsedSnapshot$1): SnapshotDiff$1;
/**
 * Convenience: diff two hydrated Snapshot rows (for example, values returned
 * by `loadSnapshot`). Physical compact rows from `smithersSnapshots` do not
 * contain inline JSON payloads.
 *
 * @param {Snapshot} a
 * @param {Snapshot} b
 * @returns {SnapshotDiff}
 */
declare function diffRawSnapshots(a: Snapshot$2, b: Snapshot$2): SnapshotDiff$1;
/**
 * Colorized terminal output for a snapshot diff.
 *
 * @param {SnapshotDiff} diff
 * @returns {string}
 */
declare function formatDiffForTui(diff: SnapshotDiff$1): string;
/**
 * Structured JSON output for a snapshot diff.
 *
 * @param {SnapshotDiff} diff
 * @returns {SnapshotDiff}
 */
declare function formatDiffAsJson(diff: SnapshotDiff$1): SnapshotDiff$1;
type ParsedSnapshot$1 = ParsedSnapshot$3;
type Snapshot$2 = Snapshot$5;
type SnapshotDiff$1 = SnapshotDiff$2;

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("../BranchInfo.ts").BranchInfo} BranchInfo */
/** @typedef {import("../EffectBoundaryReport.ts").EffectBoundaryReport} EffectBoundaryReport */
/** @typedef {import("../ForkParams.ts").ForkParams} ForkParams */
/** @typedef {import("../snapshot/Snapshot.ts").Snapshot} Snapshot */
/**
 * Fork a run at the given frame, returning the child run metadata.
 *
 * @param {SmithersDb} adapter
 * @param {ForkParams} params
 * @returns {Promise<{ runId: string; branch: BranchInfo; snapshot: Snapshot; effectBoundary: EffectBoundaryReport }>}
 */
declare function forkRun(adapter: SmithersDb$9, params: ForkParams$1): Promise<{
    runId: string;
    branch: BranchInfo$1;
    snapshot: Snapshot$1;
    effectBoundary: EffectBoundaryReport$1;
}>;
/**
 * List branches that were forked from the given parent run.
 *
 * @param {SmithersDb} adapter
 * @param {string} parentRunId
 * @returns {Promise<BranchInfo[]>}
 */
declare function listBranches(adapter: SmithersDb$9, parentRunId: string): Promise<BranchInfo$1[]>;
/**
 * Get the branch record for a run, if any.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<BranchInfo | undefined>}
 */
declare function getBranchInfo(adapter: SmithersDb$9, runId: string): Promise<BranchInfo$1 | undefined>;
type SmithersDb$9 = _smithers_orchestrator_db_adapter.SmithersDb;
type BranchInfo$1 = BranchInfo$2;
type EffectBoundaryReport$1 = EffectBoundaryReport$4;
type ForkParams$1 = ForkParams$2;
type Snapshot$1 = Snapshot$5;

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/**
 * Record the current VCS revision for a run/frame pair.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<VcsTag | null>}
 */
declare function tagSnapshotVcs(adapter: SmithersDb$8, runId: string, frameNo: number, opts?: {
    cwd?: string;
}): Promise<VcsTag$1 | null>;
/**
 * Load the VCS revision tag for a run/frame pair, if any.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @returns {Promise<VcsTag | undefined>}
 */
declare function loadVcsTag(adapter: SmithersDb$8, runId: string, frameNo: number): Promise<VcsTag$1 | undefined>;
/**
 * Create a jj workspace at the revision recorded for a run/frame pair.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @param {string} workspacePath
 * @returns {Promise<{ workspacePath: string; vcsPointer: string } | null>}
 */
declare function resolveWorkflowAtRevision(adapter: SmithersDb$8, runId: string, frameNo: number, workspacePath: string): Promise<{
    workspacePath: string;
    vcsPointer: string;
} | null>;
/**
 * Revert the working copy to the VCS revision for a run/frame pair.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} frameNo
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<{ restored: boolean; vcsPointer: string | null; error?: string }>}
 */
declare function rerunAtRevision(adapter: SmithersDb$8, runId: string, frameNo: number, opts?: {
    cwd?: string;
}): Promise<{
    restored: boolean;
    vcsPointer: string | null;
    error?: string;
}>;
type SmithersDb$8 = _smithers_orchestrator_db_adapter.SmithersDb;
type VcsTag$1 = VcsTag$2;

/**
 * @param {TimelineTree} tree
 * @param {number} [indent] - recursion depth used when rendering forked child runs
 * @returns {string}
 */
declare function formatTimelineForTui(tree: TimelineTree$3, indent?: number): string;
type TimelineTree$3 = TimelineTree$4;

/**
 * @param {TimelineTree} tree
 * @returns {object}
 */
declare function formatTimelineAsJson(tree: TimelineTree$2): object;
type TimelineTree$2 = TimelineTree$4;

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("../RunTimeline.ts").RunTimeline} RunTimeline */
/** @typedef {import("../TimelineTree.ts").TimelineTree} TimelineTree */
/**
 * Build the flat timeline (snapshots + branches) for a run.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<RunTimeline>}
 */
declare function buildTimeline(adapter: SmithersDb$7, runId: string): Promise<RunTimeline$1>;
/**
 * Build the recursive timeline tree (run + all descendants) for a run.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<TimelineTree>}
 */
declare function buildTimelineTree(adapter: SmithersDb$7, runId: string): Promise<TimelineTree$1>;

type SmithersDb$7 = _smithers_orchestrator_db_adapter.SmithersDb;
type RunTimeline$1 = RunTimeline$2;
type TimelineTree$1 = TimelineTree$4;

/**
 * Physical snapshot metadata table. New content-addressed rows use empty JSON
 * strings as a compact marker; read full state through `loadSnapshot` or
 * `loadLatestSnapshot`. Legacy/direct inline rows remain writable.
 * PK: (run_id, frame_no)
 */
declare const smithersSnapshots: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_snapshots";
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_snapshots";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        frameNo: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "frame_no";
            tableName: "_smithers_snapshots";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        nodesJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "nodes_json";
            tableName: "_smithers_snapshots";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        outputsJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "outputs_json";
            tableName: "_smithers_snapshots";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        ralphJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "ralph_json";
            tableName: "_smithers_snapshots";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        inputJson: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "input_json";
            tableName: "_smithers_snapshots";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        vcsPointer: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "vcs_pointer";
            tableName: "_smithers_snapshots";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        workflowHash: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "workflow_hash";
            tableName: "_smithers_snapshots";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        contentHash: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "content_hash";
            tableName: "_smithers_snapshots";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        createdAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "created_at_ms";
            tableName: "_smithers_snapshots";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "sqlite";
}>;
/**
 * Parent-child fork relationships between runs.
 * PK: run_id (the child run)
 */
declare const smithersBranches: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_branches";
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_branches";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        parentRunId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "parent_run_id";
            tableName: "_smithers_branches";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        parentFrameNo: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "parent_frame_no";
            tableName: "_smithers_branches";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        branchLabel: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "branch_label";
            tableName: "_smithers_branches";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        forkDescription: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "fork_description";
            tableName: "_smithers_branches";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        createdAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "created_at_ms";
            tableName: "_smithers_branches";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "sqlite";
}>;
/**
 * VCS revision metadata per snapshot.
 * PK: (run_id, frame_no)
 */
declare const smithersVcsTags: drizzle_orm_sqlite_core.SQLiteTableWithColumns<{
    name: "_smithers_vcs_tags";
    schema: undefined;
    columns: {
        runId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "run_id";
            tableName: "_smithers_vcs_tags";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        frameNo: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "frame_no";
            tableName: "_smithers_vcs_tags";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        vcsType: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "vcs_type";
            tableName: "_smithers_vcs_tags";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        vcsPointer: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "vcs_pointer";
            tableName: "_smithers_vcs_tags";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        vcsRoot: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "vcs_root";
            tableName: "_smithers_vcs_tags";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        jjOperationId: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "jj_operation_id";
            tableName: "_smithers_vcs_tags";
            dataType: "string";
            columnType: "SQLiteText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {
            length: number | undefined;
        }>;
        createdAtMs: drizzle_orm_sqlite_core.SQLiteColumn<{
            name: "created_at_ms";
            tableName: "_smithers_vcs_tags";
            dataType: "number";
            columnType: "SQLiteInteger";
            data: number;
            driverParam: number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "sqlite";
}>;

declare const JUMP_RUN_ID_PATTERN: RegExp;

declare const JUMP_MAX_FRAME_NO: 2147483647;

declare class JumpToFrameError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {{ hint?: string; details?: Record<string, unknown> }} [options]
     */
    constructor(code: string, message: string, options?: {
        hint?: string;
        details?: Record<string, unknown>;
    });
    /** @type {string} */
    code: string;
    /** @type {string | undefined} */
    hint: string | undefined;
    /** @type {Record<string, unknown> | undefined} */
    details: Record<string, unknown> | undefined;
}

/**
 * Validate a jump run id argument.
 *
 * @param {unknown} runId
 * @returns {string}
 */
declare function validateJumpRunId(runId: unknown): string;

/**
 * Validate a jump frame number argument.
 *
 * @param {unknown} frameNo
 * @returns {number}
 */
declare function validateJumpFrameNo(frameNo: unknown): number;

/**
 * Rewind a run to a previous frame and make it resumable from that point.
 *
 * @param {JumpToFrameInput} input
 * @returns {Promise<JumpResult>}
 */
declare function jumpToFrame(input: JumpToFrameInput$1): Promise<JumpResult$1>;
type JumpResult$1 = JumpResult$2;
type JumpToFrameInput$1 = JumpToFrameInput$2;

/**
 * Check whether a run currently holds a rewind lock.
 *
 * @param {string} runId
 * @returns {boolean}
 */
declare function hasRewindLock(runId: string): boolean;

/**
 * Reset lock state for tests.
 */
declare function resetRewindLocksForTests(): void;

/**
 * Acquire a durable single-flight lease for one run lineage. The database
 * compare-and-set makes the exclusion visible to CLI, MCP, and server
 * processes that share the Smithers store. An expired lease can be replaced
 * atomically.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {{
 *   nowMs?: () => number;
 *   leaseTtlMs?: number;
 *   autoRenew?: boolean;
 * }} [options]
 * @returns {Promise<RewindLockHandle | null>}
 */
declare function acquireRewindLock(adapter: SmithersDb$6, runId: string, options?: {
    nowMs?: () => number;
    leaseTtlMs?: number;
    autoRenew?: boolean;
}): Promise<RewindLockHandle$1 | null>;
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./RewindLockHandle.ts").RewindLockHandle} RewindLockHandle */
declare const REWIND_LEASE_TTL_MS: 60000;
type SmithersDb$6 = _smithers_orchestrator_db_adapter.SmithersDb;
type RewindLockHandle$1 = RewindLockHandle$2;

declare const REWIND_RATE_LIMIT_MAX: 10;

declare const REWIND_RATE_LIMIT_WINDOW_MS: number;

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/**
 * Evaluate caller-scoped rewind quota for one run.
 *
 * @param {{
 *   adapter: SmithersDb;
 *   runId: string;
 *   caller: string;
 *   nowMs?: () => number;
 *   maxPerWindow?: number;
 *   windowMs?: number;
 * }} input
 */
declare function evaluateRewindRateLimit(input: {
    adapter: SmithersDb$5;
    runId: string;
    caller: string;
    nowMs?: () => number;
    maxPerWindow?: number;
    windowMs?: number;
}): Promise<{
    limited: boolean;
    used: number;
    remaining: number;
    max: number;
    windowMs: number;
    windowStartedAtMs: number;
}>;
type SmithersDb$5 = _smithers_orchestrator_db_adapter.SmithersDb;

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./RewindAuditResult.ts").RewindAuditResult} RewindAuditResult */
/**
 * Persist one audit row for a jump-to-frame attempt.
 *
 * @param {SmithersDb} adapter
 * @param {{
 *   runId: string;
 *   fromFrameNo: number;
 *   toFrameNo: number;
 *   caller: string;
 *   timestampMs: number;
 *   result: RewindAuditResult;
 *   durationMs?: number | null;
 * }} row
 * @returns {Promise<number | null>}
 */
declare function writeRewindAuditRow(adapter: SmithersDb$4, row: {
    runId: string;
    fromFrameNo: number;
    toFrameNo: number;
    caller: string;
    timestampMs: number;
    result: RewindAuditResult$3;
    durationMs?: number | null;
}): Promise<number | null>;
type SmithersDb$4 = _smithers_orchestrator_db_adapter.SmithersDb;
type RewindAuditResult$3 = RewindAuditResult$4;

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./RewindAuditResult.ts").RewindAuditResult} RewindAuditResult */
/**
 * Update an existing rewind audit row's result and duration.
 * Used to mark an `in_progress` row as `success`, `failed`, or `partial`.
 *
 * @param {SmithersDb} adapter
 * @param {{ id: number; result: RewindAuditResult; durationMs?: number | null; fromFrameNo?: number }} row
 */
declare function updateRewindAuditRow(adapter: SmithersDb$3, row: {
    id: number;
    result: RewindAuditResult$2;
    durationMs?: number | null;
    fromFrameNo?: number;
}): Promise<void>;
type SmithersDb$3 = _smithers_orchestrator_db_adapter.SmithersDb;
type RewindAuditResult$2 = RewindAuditResult$4;

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/**
 * Count audit rows for one caller and run in a time window.
 * Only counts terminal (non-in_progress) rows so that a live attempt
 * does not itself blow the rate-limit quota, and skips `rejected` rows so
 * that retries of a refused rewind cannot keep refreshing the window and
 * lock the caller out indefinitely.
 *
 * @param {SmithersDb} adapter
 * @param {{ runId: string; caller: string; sinceMs: number; }} input
 * @returns {Promise<number>}
 */
declare function countRecentRewindAuditRows(adapter: SmithersDb$2, input: {
    runId: string;
    caller: string;
    sinceMs: number;
}): Promise<number>;
type SmithersDb$2 = _smithers_orchestrator_db_adapter.SmithersDb;

/**
 * Fetch audit rows for tests and diagnostics.
 *
 * @param {SmithersDb} adapter
 * @param {{ runId?: string; limit?: number; }} [input]
 * @returns {Promise<Array<RewindAuditRow>>}
 */
declare function listRewindAuditRows(adapter: SmithersDb$1, input?: {
    runId?: string;
    limit?: number;
}): Promise<Array<RewindAuditRow>>;
type SmithersDb$1 = _smithers_orchestrator_db_adapter.SmithersDb;
type RewindAuditResult$1 = RewindAuditResult$4;
type RewindAuditRow = {
    id: number;
    runId: string;
    fromFrameNo: number;
    toFrameNo: number;
    caller: string;
    timestampMs: number;
    result: RewindAuditResult$1;
    durationMs: number | null;
};

/**
 * On startup, find rewind audit rows left in `in_progress` by a prior crash,
 * mark them as `partial`, and fail the associated runs with a durable
 * `needsAttention` error payload.
 *
 * @param {SmithersDb} adapter
 * @param {{ nowMs?: () => number; staleAfterMs?: number }} [options]
 * @returns {Promise<{ recovered: Array<{ id: number; runId: string }> }>}
 */
declare function recoverInProgressRewindAudits(adapter: SmithersDb, options?: {
    nowMs?: () => number;
    staleAfterMs?: number;
}): Promise<{
    recovered: Array<{
        id: number;
        runId: string;
    }>;
}>;
type SmithersDb = _smithers_orchestrator_db_adapter.SmithersDb;

type BranchInfo = BranchInfo$2;
type ForkParams = ForkParams$2;
type NodeChange = NodeChange$1;
type NodeSnapshot = NodeSnapshot$1;
type OutputChange = OutputChange$1;
type ParsedSnapshot = ParsedSnapshot$3;
type RalphChange = RalphChange$1;
type RalphSnapshot = RalphSnapshot$1;
type ReplayParams = ReplayParams$2;
type ReplayResult = ReplayResult$2;
type RunTimeline = RunTimeline$2;
type Snapshot = Snapshot$5;
type SnapshotData = SnapshotData$2;
type SnapshotDiff = SnapshotDiff$2;
type TimelineFrame = TimelineFrame$1;
type TimelineTree = TimelineTree$4;
type VcsTag = VcsTag$2;
type JumpResult = JumpResult$2;
type JumpToFrameInput = JumpToFrameInput$2;
type JumpStepName = JumpStepName$1;
type RewindLockHandle = RewindLockHandle$2;
type RewindAuditResult = RewindAuditResult$4;
type RevertOptions = RevertOptions$2;
type RevertResult = RevertResult$2;
type TimeTravelOptions = TimeTravelOptions$2;
type TimeTravelResult = TimeTravelResult$2;
type CrossedEffect = CrossedEffect$1;
type EffectBoundaryParams = EffectBoundaryParams$2;
type EffectBoundaryReport = EffectBoundaryReport$4;

export { type BranchInfo, type CrossedEffect, type EffectBoundaryParams, type EffectBoundaryReport, type ForkParams, JUMP_MAX_FRAME_NO, JUMP_RUN_ID_PATTERN, type JumpResult, type JumpStepName, JumpToFrameError, type JumpToFrameInput, type NodeChange, type NodeSnapshot, type OutputChange, type ParsedSnapshot, REWIND_LEASE_TTL_MS, REWIND_RATE_LIMIT_MAX, REWIND_RATE_LIMIT_WINDOW_MS, type RalphChange, type RalphSnapshot, type ReplayParams, type ReplayResult, type RevertOptions, type RevertResult, type RewindAuditResult, type RewindLockHandle, type RunTimeline, type Snapshot, type SnapshotData, type SnapshotDiff, type TimeTravelOptions, type TimeTravelResult, type TimelineFrame, type TimelineTree, type VcsTag, acquireRewindLock, assessEffectBoundary, buildTimeline, buildTimelineTree, captureSnapshot, countRecentRewindAuditRows, diffRawSnapshots, diffSnapshots, evaluateRewindRateLimit, executeEffectReverts, forkRun, formatDiffAsJson, formatDiffForTui, formatTimelineAsJson, formatTimelineForTui, getBranchInfo, hasRewindLock, jumpToFrame, listBranches, listRewindAuditRows, listSnapshots, loadLatestSnapshot, loadSnapshot, loadVcsTag, parseSnapshot, recoverInProgressRewindAudits, replayFromCheckpoint, rerunAtRevision, resetRewindLocksForTests, resolveWorkflowAtRevision, revertToAttempt, smithersBranches, smithersSnapshots, smithersVcsTags, tagSnapshotVcs, timeTravel, updateRewindAuditRow, validateJumpFrameNo, validateJumpRunId, writeRewindAuditRow };
