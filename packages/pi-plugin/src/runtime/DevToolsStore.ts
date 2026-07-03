import { applyDelta } from "@smithers-orchestrator/devtools";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import type { DevToolsDelta, DevToolsNode, DevToolsSnapshot } from "@smithers-orchestrator/protocol";
import { DevToolsClient } from "./DevToolsClient.js";
import { normalizeState } from "./normalizeState.js";

type DevToolsGapResync = {
  fromSeq: number;
  toSeq: number;
};

type RunStateView = Record<string, unknown>;

type SnapshotWithRunState = DevToolsSnapshot & {
  runState?: RunStateView;
};

type DevToolsRuntimeEvent =
  | { version: 1; kind: "snapshot"; snapshot: SnapshotWithRunState }
  | { version: 1; kind: "delta"; delta: DevToolsDelta }
  | { version: 1; kind: "gapResync"; gapResync: DevToolsGapResync };

type ConnectionState =
  | { kind: "disconnected" }
  | { kind: "connecting" }
  | { kind: "streaming" }
  | { kind: "error"; error: Error };

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

type LiveRunDevToolsMode = { kind: "live" } | { kind: "historical"; frameNo: number };

type StoreListener = (store: DevToolsStore) => void;

const DEFAULT_GHOST_NODE_CAP = 256;
const DEFAULT_STALE_BANNER_DELAY_MS = 2_000;

function cloneNode(node: DevToolsNode) {
  return structuredClone(node);
}

function cloneSnapshot(snapshot: SnapshotWithRunState) {
  return structuredClone(snapshot);
}

function findNode(root: DevToolsNode | undefined, id: number): DevToolsNode | undefined {
  if (!root) {
    return undefined;
  }
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) {
      continue;
    }
    if (node.id === id) {
      return node;
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      stack.push(node.children[index]);
    }
  }
  return undefined;
}

function collectGhostKeys(node: DevToolsNode, keys: Set<string>) {
  const key = ghostMapKey(node);
  if (key) {
    keys.add(key);
  }
  for (const child of node.children) {
    collectGhostKeys(child, keys);
  }
}

function ghostMapKey(node: DevToolsNode) {
  const nodeId = node.task?.nodeId;
  return nodeId && nodeId.length > 0 ? nodeId : undefined;
}

function selectionKey(node: DevToolsNode) {
  return ghostMapKey(node) ?? `selected:${node.id}`;
}

function stateString(node: DevToolsNode | undefined) {
  const raw = node?.props.state;
  return typeof raw === "string" ? raw : undefined;
}

function runStatusForRoot(root: DevToolsNode | undefined, fallback: string) {
  switch (normalizeState(stateString(root))) {
    case "running":
    case "in-progress":
      return "running";
    case "waitingapproval":
    case "waiting-approval":
    case "blocked":
      return "waiting-approval";
    case "finished":
    case "complete":
    case "completed":
    case "success":
    case "succeeded":
    case "done":
      return "finished";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return fallback;
  }
}

function runStatusForSnapshot(snapshot: SnapshotWithRunState, fallback: string) {
  const state = snapshot.runState?.state;
  if (typeof state === "string") {
    return runStatusForRoot({ ...snapshot.root, props: { state } }, fallback);
  }
  return runStatusForRoot(snapshot.root, fallback);
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

class ReconnectBackoff {
  attempt = 0;
  readonly initialDelayMs = 1_000;
  readonly maxDelayMs = 30_000;

  currentDelayMs() {
    if (this.attempt <= 0) {
      return this.initialDelayMs;
    }
    return Math.min(this.initialDelayMs * 2 ** (this.attempt - 1), this.maxDelayMs);
  }

  recordFailure() {
    this.attempt += 1;
  }

  reset() {
    this.attempt = 0;
  }
}

export class DevToolsStore {
  readonly client: DevToolsClient;
  readonly ghostNodeCap: number;
  readonly staleBannerDelayMs: number;
  tree: DevToolsNode | undefined;
  seq = 0;
  lastEventAt: Date | undefined;
  selectedNodeId: number | undefined;
  isGhost = false;
  connectionState: ConnectionState = { kind: "disconnected" };
  staleSince: Date | undefined;
  isStaleBannerVisible = false;
  ghostNodes = new Map<string, GhostNodeRecord>();
  mode: LiveRunDevToolsMode = { kind: "live" };
  latestFrameNo = 0;
  scrubError: Error | undefined;
  rewindError: Error | undefined;
  rewindInFlight = false;
  runningNodeCount = 0;
  runningNodeIds = new Set<string>();
  eventsApplied = 0;
  reconnectCount = 0;
  decodeErrorCount = 0;
  runStatus = "unknown";
  runStateView: RunStateView | undefined;
  lastToastMessage: string | undefined;
  lastAuditRowId: string | undefined;
  runId: string | undefined;
  bufferedLiveEvents = 0;

  private readonly listeners = new Set<StoreListener>();
  private readonly toastSink: (message: string) => void;
  private readonly backoff = new ReconnectBackoff();
  private streamAbort: AbortController | undefined;
  private staleBannerTimer: ReturnType<typeof setTimeout> | undefined;
  private shouldReconnect = false;
  private stateRunId: string | undefined;
  private selectedNodeGhostKey: string | undefined;
  private readonly lastSeqSeenByRunId = new Map<string, number>();
  private readonly mountedFrameByGhostKey = new Map<string, number>();
  private readonly ghostEvictionOrder: string[] = [];
  private liveSnapshot: SnapshotWithRunState | undefined;
  private liveLatestFrameNo = 0;
  private awaitingSnapshotAfterGapResync = false;

  constructor(options: StoreOptions = {}) {
    this.client = options.client ?? new DevToolsClient();
    this.ghostNodeCap = Math.max(1, options.ghostNodeCap ?? this.resolvedGhostNodeCap());
    this.staleBannerDelayMs = Math.max(1, options.staleBannerDelayMs ?? DEFAULT_STALE_BANNER_DELAY_MS);
    this.toastSink = options.toastSink ?? (() => undefined);
  }

  get heartbeatAgeMs() {
    if (!this.lastEventAt) {
      return Number.MAX_SAFE_INTEGER;
    }
    return Date.now() - this.lastEventAt.getTime();
  }

  get selectedNode() {
    if (this.selectedNodeId !== undefined) {
      const active = findNode(this.tree, this.selectedNodeId);
      if (active) {
        return active;
      }
    }
    if (this.isGhost && this.selectedNodeGhostKey) {
      return this.ghostNodes.get(this.selectedNodeGhostKey)?.node;
    }
    return undefined;
  }

  get selectedGhostRecord() {
    if (!this.isGhost || !this.selectedNodeGhostKey) {
      return undefined;
    }
    return this.ghostNodes.get(this.selectedNodeGhostKey);
  }

  get displayedFrameNo() {
    return this.mode.kind === "historical" ? this.mode.frameNo : this.latestFrameNo;
  }

  get isRunFinished() {
    return this.runStatus === "finished" || this.runStatus === "failed" || this.runStatus === "cancelled";
  }

  get isRewindEligible() {
    return this.mode.kind === "historical" && !this.isRunFinished && !this.rewindInFlight;
  }

  subscribe(listener: StoreListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect(runId: string) {
    this.streamAbort?.abort();
    this.clearStaleBannerTimer();

    const preservingExistingRunState = this.stateRunId === runId;
    this.runId = runId;
    this.shouldReconnect = true;
    this.connectionState = { kind: "connecting" };
    this.backoff.reset();
    this.mode = { kind: "live" };
    this.scrubError = undefined;
    this.rewindError = undefined;
    this.rewindInFlight = false;
    this.bufferedLiveEvents = 0;
    this.staleSince = undefined;
    this.isStaleBannerVisible = false;
    this.awaitingSnapshotAfterGapResync = false;
    this.lastToastMessage = undefined;
    this.lastAuditRowId = undefined;

    if (!preservingExistingRunState) {
      this.resetForNewRun(runId);
    } else {
      this.syncDisplayedTreeWithLive();
      this.updateGhostState();
    }

    this.startStream(runId, preservingExistingRunState ? this.lastSeenSeq(runId) : undefined);
    this.emit();
  }

  disconnect() {
    this.shouldReconnect = false;
    this.streamAbort?.abort();
    this.streamAbort = undefined;
    this.clearStaleBannerTimer();
    this.connectionState = { kind: "disconnected" };
    this.staleSince = undefined;
    this.isStaleBannerVisible = false;
    this.runId = undefined;
    this.emit();
  }

  applyEvent(event: DevToolsRuntimeEvent) {
    switch (event.kind) {
      case "snapshot":
        this.applySnapshot(event.snapshot);
        break;
      case "delta":
        this.applyDeltaEvent(event.delta);
        break;
      case "gapResync":
        this.applyGapResync(event.gapResync);
        break;
    }

    this.lastEventAt = new Date();
    this.eventsApplied += 1;
    this.markStreamHealthy();

    if (this.mode.kind === "historical") {
      this.bufferedLiveEvents += 1;
    } else {
      this.updateGhostState();
    }
    this.emit();
  }

  applyGapResync(gapResync: DevToolsGapResync) {
    const preservedTree = this.tree ? cloneNode(this.tree) : undefined;
    const preservedSeq = this.seq;
    this.liveSnapshot = undefined;
    this.awaitingSnapshotAfterGapResync = true;
    this.lastSeqSeenByRunId.set(this.runId ?? "", gapResync.toSeq);

    if (this.mode.kind === "live") {
      this.tree = preservedTree;
      this.seq = preservedSeq;
    }
  }

  applySnapshot(snapshot: SnapshotWithRunState) {
    if (!this.applySnapshotToLiveState(snapshot)) {
      return;
    }
    this.latestFrameNo = this.liveLatestFrameNo;
    if (this.mode.kind === "live") {
      this.syncDisplayedTreeWithLive();
      this.updateGhostState();
    }
  }

  applyDeltaEvent(delta: DevToolsDelta) {
    if (!this.applyDeltaToLiveState(delta)) {
      return;
    }
    this.latestFrameNo = Math.max(this.latestFrameNo, this.liveLatestFrameNo);
    if (this.mode.kind === "live") {
      this.syncDisplayedTreeWithLive();
      this.updateGhostState();
    }
  }

  async scrubTo(frameNo: number) {
    if (!this.runId) {
      this.scrubError = new SmithersError("PI_RUN_NOT_FOUND", "Missing runId.");
      this.emit();
      return;
    }

    const targetFrame = Math.max(0, Math.floor(frameNo));
    if (this.latestFrameNo > 0 && targetFrame >= this.latestFrameNo) {
      this.returnToLive();
      return;
    }

    this.mode = { kind: "historical", frameNo: targetFrame };
    try {
      const snapshot = await this.client.getDevToolsSnapshot(this.runId, targetFrame);
      this.tree = snapshot.root;
      this.seq = snapshot.seq;
      this.mode = { kind: "historical", frameNo: snapshot.frameNo };
      this.scrubError = undefined;
      this.refreshRunningState();
      this.updateGhostState();
    } catch (error) {
      this.scrubError = error instanceof Error ? error : new Error(String(error));
    }
    this.emit();
  }

  returnToLive() {
    if (this.mode.kind !== "historical") {
      return;
    }
    this.mode = { kind: "live" };
    this.scrubError = undefined;
    this.bufferedLiveEvents = 0;
    this.syncDisplayedTreeWithLive();
    this.updateGhostState();
    if (this.runId && this.shouldReconnect) {
      this.requestResync(this.runId);
    }
    this.emit();
  }

  async rewind(frameNo: number, confirm = false) {
    if (!confirm || this.rewindInFlight) {
      return;
    }
    if (!this.runId) {
      this.rewindError = new SmithersError("PI_RUN_NOT_FOUND", "Missing runId.");
      this.emit();
      return;
    }
    if (this.isRunFinished) {
      this.rewindError = new SmithersError("PI_REWIND_FAILED", "Run is no longer live; rewind is unavailable.");
      this.emit();
      return;
    }
    if (this.mode.kind !== "historical") {
      this.rewindError = new SmithersError("PI_CONFIRMATION_REQUIRED", "Choose a historical frame before rewinding.");
      this.emit();
      return;
    }

    this.rewindInFlight = true;
    this.rewindError = undefined;
    this.emit();

    try {
      const result = await this.client.rewind(this.runId, frameNo, true);
      const snapshot = await this.client.getDevToolsSnapshot(this.runId);
      this.applySnapshotToLiveState(snapshot);
      this.pruneGhostNodesForRewind(frameNo);
      this.mode = { kind: "live" };
      this.bufferedLiveEvents = 0;
      this.scrubError = undefined;
      this.rewindError = undefined;
      this.syncDisplayedTreeWithLive();
      this.updateGhostState();
      this.lastAuditRowId = typeof result.auditRowId === "string" ? result.auditRowId : undefined;
      this.lastToastMessage = this.lastAuditRowId
        ? `Rewound to frame ${frameNo}. Audit: ${this.lastAuditRowId}`
        : `Rewound to frame ${frameNo}.`;
      this.toastSink(this.lastToastMessage);
      this.requestResync(this.runId);
    } catch (error) {
      this.rewindError = error instanceof Error ? error : new Error(String(error));
    } finally {
      this.rewindInFlight = false;
      this.emit();
    }
  }

  clearHistoricalError() {
    this.scrubError = undefined;
    this.emit();
  }

  clearRewindError() {
    this.rewindError = undefined;
    this.emit();
  }

  selectNode(nodeId: number | undefined) {
    this.selectedNodeId = nodeId;
    if (nodeId !== undefined) {
      const node = findNode(this.tree, nodeId);
      if (node) {
        this.selectedNodeGhostKey = selectionKey(node);
      }
    }
    this.updateGhostState();
    this.emit();
  }

  clearSelection() {
    this.selectedNodeId = undefined;
    this.selectedNodeGhostKey = undefined;
    this.isGhost = false;
    this.emit();
  }

  clearHistory() {
    this.ghostNodes.clear();
    this.ghostEvictionOrder.length = 0;
    this.mountedFrameByGhostKey.clear();
    this.updateGhostState();
    this.emit();
  }

  isGhostNode(node: DevToolsNode) {
    const key = ghostMapKey(node);
    return key ? this.ghostNodes.has(key) : false;
  }

  ghostRecord(node: DevToolsNode) {
    const key = ghostMapKey(node);
    return key ? this.ghostNodes.get(key) : undefined;
  }

  private startStream(runId: string, afterSeq?: number) {
    this.streamAbort?.abort();
    const abort = new AbortController();
    this.streamAbort = abort;
    void this.consumeStream(runId, afterSeq, abort.signal);
  }

  private async consumeStream(runId: string, afterSeq: number | undefined, signal: AbortSignal) {
    let nextAfterSeq = afterSeq;
    while (this.shouldReconnect && !signal.aborted) {
      this.connectionState = { kind: "connecting" };
      this.emit();
      try {
        for await (const event of this.client.streamDevTools(runId, nextAfterSeq, signal)) {
          if (signal.aborted) {
            return;
          }
          if (this.connectionState.kind === "connecting") {
            this.connectionState = { kind: "streaming" };
          }
          this.applyEvent(event);
        }
        if (signal.aborted || !this.shouldReconnect) {
          return;
        }
        this.markConnectionInterrupted();
      } catch (error) {
        if (signal.aborted || !this.shouldReconnect) {
          return;
        }
        const err = error instanceof Error ? error : new Error(String(error));
        if (err.message.includes("DevTools event")) {
          this.decodeErrorCount += 1;
          nextAfterSeq = undefined;
        }
        this.connectionState = { kind: "error", error: err };
        this.markConnectionInterrupted();
      }

      this.backoff.recordFailure();
      this.reconnectCount += 1;
      nextAfterSeq = nextAfterSeq ?? this.lastSeenSeq(runId);
      const delayMs = this.backoff.currentDelayMs();
      this.emit();
      await sleep(delayMs, signal);
    }
  }

  private requestResync(runId: string) {
    if (!this.shouldReconnect) {
      return;
    }
    this.streamAbort?.abort();
    this.awaitingSnapshotAfterGapResync = false;
    this.startStream(runId, undefined);
  }

  private applySnapshotToLiveState(snapshot: SnapshotWithRunState) {
    if (this.runId && snapshot.runId !== this.runId) {
      this.disconnect();
      return false;
    }
    if (snapshot.seq <= (this.liveSnapshot?.seq ?? 0) && this.liveSnapshot && !this.awaitingSnapshotAfterGapResync) {
      return false;
    }

    if (this.liveSnapshot) {
      this.captureGhostNodesRemovedBySnapshot(
        this.liveSnapshot.root,
        snapshot.root,
        snapshot.frameNo,
        snapshot.seq,
      );
    }

    this.awaitingSnapshotAfterGapResync = false;
    this.liveSnapshot = cloneSnapshot(snapshot);
    this.liveLatestFrameNo = Math.max(this.liveLatestFrameNo, snapshot.frameNo);
    this.runStateView = snapshot.runState;
    this.runStatus = runStatusForSnapshot(snapshot, this.runStatus);
    this.recordMountedFrames(snapshot.root, snapshot.frameNo);
    this.pruneGhostNodesNowActive(snapshot.root);
    this.stateRunId = snapshot.runId;
    this.lastSeqSeenByRunId.set(snapshot.runId, snapshot.seq);
    return true;
  }

  private applyDeltaToLiveState(delta: DevToolsDelta) {
    if (this.awaitingSnapshotAfterGapResync) {
      return false;
    }
    if (this.liveSnapshot && delta.seq <= this.liveSnapshot.seq) {
      return false;
    }
    if (this.liveSnapshot && delta.baseSeq !== this.liveSnapshot.seq) {
      if (this.runId) {
        this.requestResync(this.runId);
      }
      return false;
    }

    this.captureGhostNodesFromDelta(delta);
    try {
      const base = this.liveSnapshot ?? {
        version: 1 as const,
        runId: this.runId ?? "",
        frameNo: delta.baseSeq,
        seq: delta.baseSeq,
        root: undefined as unknown as DevToolsNode,
      };
      this.liveSnapshot = applyDelta(base, delta) as SnapshotWithRunState;
      this.liveLatestFrameNo = Math.max(this.liveLatestFrameNo, this.liveSnapshot.frameNo, delta.seq);
      this.recordMountedFramesFromDelta(delta, this.liveLatestFrameNo);
      if (this.runId) {
        this.lastSeqSeenByRunId.set(this.runId, delta.seq);
      }
      this.runStatus = runStatusForRoot(this.liveSnapshot.root, this.runStatus);
      this.pruneGhostNodesNowActive(this.liveSnapshot.root);
      return true;
    } catch {
      if (this.runId) {
        this.requestResync(this.runId);
      }
      return false;
    }
  }

  private syncDisplayedTreeWithLive() {
    this.tree = this.liveSnapshot?.root;
    this.seq = this.liveSnapshot?.seq ?? 0;
    this.latestFrameNo = this.liveLatestFrameNo;
    this.refreshRunningState();
  }

  private refreshRunningState() {
    const ids = new Set<string>();
    let count = 0;
    const walk = (node: DevToolsNode) => {
      if (node.type === "task" && node.children.length === 0 && normalizeState(stateString(node)) === "running") {
        count += 1;
        if (node.task?.nodeId) {
          ids.add(node.task.nodeId);
        }
      }
      for (const child of node.children) {
        walk(child);
      }
    };
    if (this.tree) {
      walk(this.tree);
    }
    this.runningNodeCount = count;
    this.runningNodeIds = ids;
  }

  private resetForNewRun(runId: string) {
    this.stateRunId = runId;
    this.tree = undefined;
    this.seq = 0;
    this.liveSnapshot = undefined;
    this.latestFrameNo = 0;
    this.liveLatestFrameNo = 0;
    this.runStatus = "unknown";
    this.runStateView = undefined;
    this.runningNodeCount = 0;
    this.runningNodeIds.clear();
    this.selectedNodeId = undefined;
    this.selectedNodeGhostKey = undefined;
    this.ghostNodes.clear();
    this.ghostEvictionOrder.length = 0;
    this.mountedFrameByGhostKey.clear();
  }

  private lastSeenSeq(runId: string) {
    if (this.stateRunId !== runId || !this.liveSnapshot || this.liveSnapshot.seq <= 0) {
      return undefined;
    }
    return Math.max(this.lastSeqSeenByRunId.get(runId) ?? 0, this.liveSnapshot.seq);
  }

  private markConnectionInterrupted() {
    if (!this.staleSince) {
      this.staleSince = new Date();
    }
    this.scheduleStaleBannerReveal();
  }

  private markStreamHealthy() {
    this.connectionState = { kind: "streaming" };
    this.backoff.reset();
    this.clearStaleBannerTimer();
    this.staleSince = undefined;
    this.isStaleBannerVisible = false;
  }

  private scheduleStaleBannerReveal() {
    const staleSince = this.staleSince;
    if (!staleSince) {
      return;
    }
    this.clearStaleBannerTimer();
    this.staleBannerTimer = setTimeout(() => {
      if (this.staleSince?.getTime() === staleSince.getTime() && this.connectionState.kind !== "streaming") {
        this.isStaleBannerVisible = true;
        this.emit();
      }
    }, this.staleBannerDelayMs);
  }

  private clearStaleBannerTimer() {
    if (this.staleBannerTimer) {
      clearTimeout(this.staleBannerTimer);
      this.staleBannerTimer = undefined;
    }
  }

  private updateGhostState() {
    if (this.selectedNodeId === undefined) {
      this.isGhost = false;
      this.selectedNodeGhostKey = undefined;
      return;
    }
    const activeNode = findNode(this.tree, this.selectedNodeId);
    if (activeNode) {
      this.selectedNodeGhostKey = selectionKey(activeNode);
      this.isGhost = false;
      return;
    }
    if (this.selectedNodeGhostKey && this.ghostNodes.has(this.selectedNodeGhostKey)) {
      this.isGhost = true;
      return;
    }
    this.selectedNodeId = undefined;
    this.selectedNodeGhostKey = undefined;
    this.isGhost = false;
  }

  private recordMountedFrames(root: DevToolsNode, frameNo: number) {
    const key = ghostMapKey(root);
    if (key) {
      this.mountedFrameByGhostKey.set(
        key,
        Math.min(this.mountedFrameByGhostKey.get(key) ?? frameNo, frameNo),
      );
    }
    for (const child of root.children) {
      this.recordMountedFrames(child, frameNo);
    }
  }

  private recordMountedFramesFromDelta(delta: DevToolsDelta, frameNo: number) {
    for (const op of delta.ops) {
      if (op.op === "addNode" || op.op === "replaceRoot") {
        this.recordMountedFrames(op.node, frameNo);
      }
    }
  }

  private captureGhostNodesRemovedBySnapshot(
    previousRoot: DevToolsNode,
    nextRoot: DevToolsNode,
    unmountedFrameNo: number,
    unmountedSeq: number,
  ) {
    const nextKeys = new Set<string>();
    collectGhostKeys(nextRoot, nextKeys);
    this.registerRemovedGhostNodes(previousRoot, nextKeys, unmountedFrameNo, unmountedSeq);
  }

  private registerRemovedGhostNodes(
    node: DevToolsNode,
    activeKeys: Set<string>,
    unmountedFrameNo: number,
    unmountedSeq: number,
  ) {
    const key = ghostMapKey(node);
    if (key && !activeKeys.has(key)) {
      this.registerGhostSubtree(node, unmountedFrameNo, unmountedSeq);
      return;
    }
    for (const child of node.children) {
      this.registerRemovedGhostNodes(child, activeKeys, unmountedFrameNo, unmountedSeq);
    }
  }

  private captureGhostNodesFromDelta(delta: DevToolsDelta) {
    const root = this.liveSnapshot?.root;
    if (!root) {
      return;
    }
    const unmountedFrameNo = Math.max(this.liveLatestFrameNo, delta.seq);
    for (const op of delta.ops) {
      if (op.op === "removeNode") {
        if (root.id === op.id) {
          this.registerGhostSubtree(root, unmountedFrameNo, delta.seq);
          continue;
        }
        const removed = findNode(root, op.id);
        if (removed) {
          this.registerGhostSubtree(removed, unmountedFrameNo, delta.seq);
        }
      } else if (op.op === "replaceRoot") {
        this.captureGhostNodesRemovedBySnapshot(root, op.node, unmountedFrameNo, delta.seq);
      }
    }
  }

  private registerGhostSubtree(node: DevToolsNode, unmountedFrameNo: number, unmountedSeq: number) {
    this.registerGhostNode(node, unmountedFrameNo, unmountedSeq);
    for (const child of node.children) {
      this.registerGhostSubtree(child, unmountedFrameNo, unmountedSeq);
    }
  }

  private registerGhostNode(node: DevToolsNode, unmountedFrameNo: number, unmountedSeq: number) {
    const key = ghostMapKey(node);
    if (!key) {
      return;
    }
    const mountedFrameNo = this.mountedFrameByGhostKey.get(key) ?? unmountedFrameNo;
    this.ghostNodes.set(key, {
      key,
      node: cloneNode(node),
      mountedFrameNo,
      unmountedFrameNo,
      unmountedSeq,
      capturedAtMs: Date.now(),
    });
    const existing = this.ghostEvictionOrder.indexOf(key);
    if (existing >= 0) {
      this.ghostEvictionOrder.splice(existing, 1);
    }
    this.ghostEvictionOrder.push(key);
    this.enforceGhostBudget();
  }

  private enforceGhostBudget() {
    const keysToEvict: string[] = [];
    while (this.ghostNodes.size - keysToEvict.length > this.ghostNodeCap && this.ghostEvictionOrder.length > 0) {
      const key = this.ghostEvictionOrder.shift();
      if (key) {
        keysToEvict.push(key);
      }
    }
    this.removeGhostRecords(keysToEvict);
  }

  private pruneGhostNodesNowActive(root: DevToolsNode | undefined) {
    if (!root) {
      return;
    }
    const activeKeys = new Set<string>();
    collectGhostKeys(root, activeKeys);
    this.removeGhostRecords([...this.ghostNodes.keys()].filter((key) => activeKeys.has(key)), false);
  }

  private pruneGhostNodesForRewind(targetFrameNo: number) {
    this.removeGhostRecords(
      [...this.ghostNodes.values()]
        .filter((record) => record.mountedFrameNo > targetFrameNo)
        .map((record) => record.key),
    );
  }

  private removeGhostRecords(keys: string[], removeMountTracking = true) {
    if (keys.length === 0) {
      return;
    }
    const keySet = new Set(keys);
    for (const key of keySet) {
      this.ghostNodes.delete(key);
      if (removeMountTracking) {
        this.mountedFrameByGhostKey.delete(key);
      }
    }
    for (let index = this.ghostEvictionOrder.length - 1; index >= 0; index -= 1) {
      if (keySet.has(this.ghostEvictionOrder[index])) {
        this.ghostEvictionOrder.splice(index, 1);
      }
    }
    if (this.selectedNodeGhostKey && keySet.has(this.selectedNodeGhostKey)) {
      if (this.selectedNodeId !== undefined && findNode(this.tree, this.selectedNodeId)) {
        this.isGhost = false;
        this.selectedNodeGhostKey = undefined;
      } else {
        this.clearSelection();
      }
    }
  }

  private resolvedGhostNodeCap() {
    const raw = process.env.SMITHERS_DEVTOOLS_GHOST_CAP;
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GHOST_NODE_CAP;
  }

  private emit() {
    for (const listener of this.listeners) {
      listener(this);
    }
  }
}
