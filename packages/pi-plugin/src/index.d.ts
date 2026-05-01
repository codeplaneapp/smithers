import { SmithersAgentContract } from '@smithers-orchestrator/agents/agent-contract';
import { ExtensionAPI as ExtensionAPI$1 } from '@mariozechner/pi-coding-agent';
import { DevToolsSnapshot, DevToolsDelta, DevToolsNode } from '@smithers-orchestrator/protocol';

type ApproveArgs = {
    runId: string;
    nodeId: string;
    iteration?: number;
    note?: string;
    baseUrl?: string;
    apiKey?: string;
};
declare function approve(args: ApproveArgs): Promise<any>;

type CancelArgs = {
    runId: string;
    baseUrl?: string;
    apiKey?: string;
};
declare function cancel(args: CancelArgs): Promise<any>;

type DenyArgs = {
    runId: string;
    nodeId: string;
    iteration?: number;
    note?: string;
    baseUrl?: string;
    apiKey?: string;
};
declare function deny(args: DenyArgs): Promise<any>;

type GetFramesArgs = {
    runId: string;
    tail?: number;
    baseUrl?: string;
    apiKey?: string;
};
declare function getFrames(args: GetFramesArgs): Promise<any>;

type GetStatusArgs = {
    runId: string;
    baseUrl?: string;
    apiKey?: string;
};
declare function getStatus(args: GetStatusArgs): Promise<any>;

type ListRunsArgs = {
    limit?: number;
    status?: string;
    baseUrl?: string;
    apiKey?: string;
};
declare function listRuns(args?: ListRunsArgs): Promise<any>;

type ResumeArgs = {
    workflowPath: string;
    runId: string;
    baseUrl?: string;
    apiKey?: string;
};
declare function resume(args: ResumeArgs): Promise<any>;

type RunWorkflowArgs = {
    workflowPath: string;
    input: unknown;
    runId?: string;
    baseUrl?: string;
    apiKey?: string;
};
declare function runWorkflow(args: RunWorkflowArgs): Promise<any>;

type StreamEventsArgs = {
    runId: string;
    baseUrl?: string;
    apiKey?: string;
};
declare function streamEvents(args: StreamEventsArgs): AsyncGenerator<any, void, unknown>;

type SmithersPiRunContext = {
    runId: string;
    workflowName: string;
    status: string;
    nodeStates: Array<{
        nodeId: string;
        state: string;
    }>;
    errors: string[];
};

declare function buildSmithersPiSystemPrompt(baseSystemPrompt: string, docs: string, contract: SmithersAgentContract, activeRun?: SmithersPiRunContext): string;

type ExtensionAPI = ExtensionAPI$1 & {
    registerFlag: (name: string, config: Record<string, unknown>) => void;
    getFlag: (name: string) => string | undefined;
    on: (event: string, handler: (...args: any[]) => unknown) => void;
    registerTool: (tool: Record<string, unknown>) => void;
    registerCommand: (name: string, command: Record<string, unknown>) => void;
    registerMessageRenderer: (name: string, renderer: (...args: any[]) => unknown) => void;
};
declare function extension(pi: ExtensionAPI): void;

type RequestOptions = {
    baseUrl?: string;
    apiKey?: string;
    clientId?: string;
    clientVersion?: string;
};
type DevToolsGapResync$1 = {
    fromSeq: number;
    toSeq: number;
};
type DevToolsRuntimeEvent$1 = {
    version: 1;
    kind: "snapshot";
    snapshot: DevToolsSnapshot & {
        runState?: RunStateView$1;
    };
} | {
    version: 1;
    kind: "delta";
    delta: DevToolsDelta;
} | {
    version: 1;
    kind: "gapResync";
    gapResync: DevToolsGapResync$1;
};
type RunStateView$1 = {
    runId?: string;
    run_id?: string;
    state?: string;
    computedAt?: string;
    computed_at?: string;
    engineHeartbeatAtMs?: number;
    engine_heartbeat_at_ms?: number;
    engineHeartbeatMs?: number;
    engine_heartbeat_ms?: number;
    viewersHeartbeatAtMs?: number;
    viewers_heartbeat_at_ms?: number;
    uiHeartbeatAtMs?: number;
    ui_heartbeat_at_ms?: number;
    viewersHeartbeatMs?: number;
    viewers_heartbeat_ms?: number;
    uiHeartbeatMs?: number;
    ui_heartbeat_ms?: number;
    engineHeartbeatAt?: string;
    engine_heartbeat_at?: string;
    viewersHeartbeatAt?: string;
    viewers_heartbeat_at?: string;
    uiHeartbeatAt?: string;
    ui_heartbeat_at?: string;
    blocked?: unknown;
    unhealthy?: unknown;
};
declare class DevToolsClient {
    readonly baseUrl: string;
    readonly apiKey: string | undefined;
    private readonly clientId;
    private readonly clientVersion;
    private readonly lastSeqSeenByRunId;
    constructor(opts?: RequestOptions);
    lastSeqSeen(runId: string): number | undefined;
    streamDevTools(runId: string, afterSeq?: number, signal?: AbortSignal): AsyncGenerator<DevToolsRuntimeEvent$1>;
    getDevToolsSnapshot(runId: string, frameNo?: number): Promise<DevToolsSnapshot & {
        runState?: RunStateView$1;
    }>;
    getNodeOutput(runId: string, nodeId: string, iteration?: number): Promise<unknown>;
    getNodeDiff(runId: string, nodeId: string, iteration?: number): Promise<unknown>;
    approve(runId: string, nodeId: string, iteration?: number, note?: string): Promise<{
        auditRowId: string | undefined;
    }>;
    deny(runId: string, nodeId: string, iteration?: number, note?: string): Promise<{
        auditRowId: string | undefined;
    }>;
    signal(runId: string, signal: string, payload?: unknown, correlationId?: string): Promise<{
        auditRowId: string | undefined;
    }>;
    cancel(runId: string): Promise<{
        auditRowId: string | undefined;
    }>;
    resume(runId: string): Promise<{
        auditRowId: string | undefined;
    }>;
    rewind(runId: string, frameNo: number, confirm?: boolean): Promise<{
        auditRowId: string | undefined;
    }>;
    private performMutation;
    private rpc;
    private assertOk;
}

type DevToolsGapResync = {
    fromSeq: number;
    toSeq: number;
};
type RunStateView = Record<string, unknown>;
type SnapshotWithRunState = DevToolsSnapshot & {
    runState?: RunStateView;
};
type DevToolsRuntimeEvent = {
    version: 1;
    kind: "snapshot";
    snapshot: SnapshotWithRunState;
} | {
    version: 1;
    kind: "delta";
    delta: DevToolsDelta;
} | {
    version: 1;
    kind: "gapResync";
    gapResync: DevToolsGapResync;
};
type ConnectionState = {
    kind: "disconnected";
} | {
    kind: "connecting";
} | {
    kind: "streaming";
} | {
    kind: "error";
    error: Error;
};
type GhostNodeRecord = {
    key: string;
    node: DevToolsNode;
    mountedFrameNo: number;
    unmountedFrameNo: number;
    unmountedSeq: number;
    capturedAtMs: number;
};
type StoreOptions = {
    client?: DevToolsClient;
    ghostNodeCap?: number;
    staleBannerDelayMs?: number;
    toastSink?: (message: string) => void;
};
type LiveRunDevToolsMode = {
    kind: "live";
} | {
    kind: "historical";
    frameNo: number;
};
type StoreListener = (store: DevToolsStore) => void;
declare class DevToolsStore {
    readonly client: DevToolsClient;
    readonly ghostNodeCap: number;
    readonly staleBannerDelayMs: number;
    tree: DevToolsNode | undefined;
    seq: number;
    lastEventAt: Date | undefined;
    selectedNodeId: number | undefined;
    isGhost: boolean;
    connectionState: ConnectionState;
    staleSince: Date | undefined;
    isStaleBannerVisible: boolean;
    ghostNodes: Map<string, GhostNodeRecord>;
    mode: LiveRunDevToolsMode;
    latestFrameNo: number;
    scrubError: Error | undefined;
    rewindError: Error | undefined;
    rewindInFlight: boolean;
    runningNodeCount: number;
    runningNodeIds: Set<string>;
    eventsApplied: number;
    reconnectCount: number;
    decodeErrorCount: number;
    runSupportsRetry: boolean;
    runStatus: string;
    runStateView: RunStateView | undefined;
    lastToastMessage: string | undefined;
    lastAuditRowId: string | undefined;
    runId: string | undefined;
    bufferedLiveEvents: number;
    private readonly listeners;
    private readonly toastSink;
    private readonly backoff;
    private streamAbort;
    private staleBannerTimer;
    private shouldReconnect;
    private stateRunId;
    private selectedNodeGhostKey;
    private readonly lastSeqSeenByRunId;
    private readonly mountedFrameByGhostKey;
    private readonly ghostEvictionOrder;
    private liveSnapshot;
    private liveLatestFrameNo;
    private awaitingSnapshotAfterGapResync;
    constructor(options?: StoreOptions);
    get heartbeatAgeMs(): number;
    get selectedNode(): DevToolsNode | undefined;
    get selectedGhostRecord(): GhostNodeRecord | undefined;
    get displayedFrameNo(): number;
    get isRunFinished(): boolean;
    get isRewindEligible(): boolean;
    subscribe(listener: StoreListener): () => boolean;
    connect(runId: string): void;
    disconnect(): void;
    applyEvent(event: DevToolsRuntimeEvent): void;
    applyGapResync(gapResync: DevToolsGapResync): void;
    applySnapshot(snapshot: SnapshotWithRunState): void;
    applyDeltaEvent(delta: DevToolsDelta): void;
    scrubTo(frameNo: number): Promise<void>;
    returnToLive(): void;
    rewind(frameNo: number, confirm?: boolean): Promise<void>;
    clearHistoricalError(): void;
    clearRewindError(): void;
    selectNode(nodeId: number | undefined): void;
    clearSelection(): void;
    clearHistory(): void;
    isGhostNode(node: DevToolsNode): boolean;
    ghostRecord(node: DevToolsNode): GhostNodeRecord | undefined;
    retryNode(_nodeId: string): void;
    private startStream;
    private consumeStream;
    private requestResync;
    private applySnapshotToLiveState;
    private applyDeltaToLiveState;
    private syncDisplayedTreeWithLive;
    private refreshRunningState;
    private resetForNewRun;
    private lastSeenSeq;
    private markConnectionInterrupted;
    private markStreamHealthy;
    private scheduleStaleBannerReveal;
    private clearStaleBannerTimer;
    private updateGhostState;
    private recordMountedFrames;
    private recordMountedFramesFromDelta;
    private captureGhostNodesRemovedBySnapshot;
    private registerRemovedGhostNodes;
    private captureGhostNodesFromDelta;
    private registerGhostSubtree;
    private registerGhostNode;
    private enforceGhostBudget;
    private pruneGhostNodesNowActive;
    private pruneGhostNodesForRewind;
    private removeGhostRecords;
    private resolvedGhostNodeCap;
    private emit;
}

type Theme$4 = {
    fg?: (color: string, value: string) => string;
    bold?: (value: string) => string;
};
declare class FrameScrubber {
    private readonly store;
    constructor(store: DevToolsStore);
    handleInput(data: string): boolean;
    render(width: number, theme: Theme$4): string[];
}

type Theme$3 = {
    fg?: (color: string, value: string) => string;
    bold?: (value: string) => string;
};
declare class Header {
    private readonly store;
    private readonly workflowName;
    constructor(store: DevToolsStore, workflowName?: string);
    render(width: number, theme: Theme$3): string[];
}

type Theme$2 = {
    fg?: (color: string, value: string) => string;
    bold?: (value: string) => string;
};
declare class NodeInspector {
    private readonly store;
    private tab;
    private scrollOffset;
    constructor(store: DevToolsStore);
    handleInput(data: string): "handled" | "unhandled";
    render(width: number, height: number, theme: Theme$2): string[];
    private bodyLines;
    private nextTab;
    private pad;
}

type Theme$1 = {
    fg?: (color: string, value: string) => string;
    bold?: (value: string) => string;
};
type RunInspectorOptions = {
    workflowName?: string;
    onClose?: () => void;
    onNotify?: (message: string, level?: "info" | "warning" | "error") => void;
};
declare class RunInspector {
    private readonly store;
    private readonly client;
    private readonly header;
    private readonly scrubber;
    private readonly tree;
    private readonly inspector;
    private readonly onClose;
    private readonly onNotify;
    private focus;
    private cachedLines;
    private cachedWidth;
    constructor(store: DevToolsStore, client: DevToolsClient, options?: RunInspectorOptions);
    handleInput(data: string): void;
    render(width: number, height: number | undefined, theme: Theme$1): string[];
    invalidate(): void;
    dispose(): void;
    private cycleFocus;
    private selectedTask;
    private approveSelected;
    private denySelected;
    private cancelRun;
    private rewindDisplayedFrame;
}

type Theme = {
    fg?: (color: string, value: string) => string;
    bold?: (value: string) => string;
};
type TreeRow = {
    node: DevToolsNode;
    depth: number;
};
declare class RunTree {
    private readonly store;
    private readonly expandedIds;
    private readonly userCollapsedIds;
    private scrollOffset;
    private searchQuery;
    private searchMode;
    private lastAutoSeq;
    constructor(store: DevToolsStore);
    handleInput(data: string): "handled" | "unhandled" | "focusInspector";
    render(width: number, height: number, theme: Theme): string[];
    visibleRows(): TreeRow[];
    private renderRow;
    private rebuildAutoExpansion;
    private ensureSelection;
    private ensureScroll;
    private moveSelection;
    private collapseSelected;
    private expandSelected;
    private selectRow;
}

export { DevToolsClient, DevToolsStore, FrameScrubber, Header, NodeInspector, RunInspector, RunTree, approve, buildSmithersPiSystemPrompt, cancel, deny, extension, getFrames, getStatus, listRuns, resume, runWorkflow, streamEvents };
