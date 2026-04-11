// ---------------------------------------------------------------------------
// Public model types
// ---------------------------------------------------------------------------

export type DevToolsNode = {
  id: number;
  /** Smithers-level type: "workflow" | "task" | "sequence" | etc. */
  type: SmithersNodeType;
  /** Display name (component function name or host tag) */
  name: string;
  /** Props snapshot (serializable subset) */
  props: Record<string, unknown>;
  /** Task-specific fields extracted from renderer raw props */
  task?: {
    nodeId: string;
    kind: "agent" | "compute" | "static";
    agent?: string;
    label?: string;
    outputTableName?: string;
    iteration?: number;
  };
  children: DevToolsNode[];
  /** Depth in the Smithers tree (not renderer tree depth) */
  depth: number;
};

export type SmithersNodeType =
  | "workflow"
  | "task"
  | "sequence"
  | "parallel"
  | "merge-queue"
  | "branch"
  | "loop"
  | "worktree"
  | "approval"
  | "timer"
  | "subflow"
  | "wait-for-event"
  | "saga"
  | "try-catch"
  | "fragment"
  | "unknown";

export type DevToolsSnapshot = {
  tree: DevToolsNode | null;
  nodeCount: number;
  taskCount: number;
  timestamp: number;
};

export type DevToolsEventHandler = (
  event: "commit" | "unmount",
  snapshot: DevToolsSnapshot,
) => void;

/** Execution state for a task, derived from SmithersEvent stream */
export type TaskExecutionState = {
  nodeId: string;
  iteration: number;
  status:
    | "pending"
    | "started"
    | "finished"
    | "failed"
    | "cancelled"
    | "skipped"
    | "waiting-approval"
    | "waiting-event"
    | "waiting-timer"
    | "retrying";
  attempt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: unknown;
  toolCalls: Array<{ name: string; seq: number; status?: "success" | "error" }>;
};

/** Execution state for a run, aggregated from SmithersEvent stream */
export type RunExecutionState = {
  runId: string;
  status:
    | "running"
    | "finished"
    | "failed"
    | "cancelled"
    | "waiting-approval"
    | "waiting-timer";
  frameNo: number;
  tasks: Map<string, TaskExecutionState>;
  events: Array<{ type: string; timestampMs: number; [key: string]: unknown }>;
  startedAt?: number;
  finishedAt?: number;
};

export type SmithersDevToolsOptions = {
  /** Called on every renderer commit that touches the Smithers tree */
  onCommit?: DevToolsEventHandler;
  /** Called on every SmithersEvent from an attached EventBus */
  onEngineEvent?: (event: any) => void;
  /** Enable verbose console logging */
  verbose?: boolean;
};

export type DevToolsEventBus = {
  on: (event: "event", handler: (e: any) => void) => void;
  removeListener: (event: "event", handler: (e: any) => void) => void;
};

export type DevToolsRunStoreOptions = Pick<
  SmithersDevToolsOptions,
  "onEngineEvent" | "verbose"
>;

// ---------------------------------------------------------------------------
// Snapshot and tree helpers
// ---------------------------------------------------------------------------

export function countNodes(node: DevToolsNode): { nodes: number; tasks: number } {
  let nodes = 1;
  let tasks = node.type === "task" ? 1 : 0;
  for (const child of node.children) {
    const c = countNodes(child);
    nodes += c.nodes;
    tasks += c.tasks;
  }
  return { nodes, tasks };
}

export function buildSnapshot(root: DevToolsNode | null): DevToolsSnapshot {
  if (!root) {
    return { tree: null, nodeCount: 0, taskCount: 0, timestamp: Date.now() };
  }
  const { nodes, tasks } = countNodes(root);
  return { tree: root, nodeCount: nodes, taskCount: tasks, timestamp: Date.now() };
}

export const SMITHERS_NODE_ICONS: Record<SmithersNodeType, string> = {
  workflow: "📋",
  task: "⚡",
  sequence: "➡️",
  parallel: "⚡",
  "merge-queue": "🔀",
  branch: "🌿",
  loop: "🔁",
  worktree: "🌳",
  approval: "✋",
  timer: "⏱️",
  subflow: "🔗",
  "wait-for-event": "📡",
  saga: "🔄",
  "try-catch": "🛡️",
  fragment: "📦",
  unknown: "❓",
};

export function printTree(node: DevToolsNode, indent: string = ""): string {
  const icon = SMITHERS_NODE_ICONS[node.type] ?? "❓";
  let line = `${indent}${icon} ${node.type}`;

  if (node.task) {
    line += ` [${node.task.nodeId}]`;
    if (node.task.kind === "agent" && node.task.agent) {
      line += ` (${node.task.agent})`;
    } else {
      line += ` (${node.task.kind})`;
    }
    if (node.task.label) {
      line += ` "${node.task.label}"`;
    }
  } else if (node.props.name) {
    line += ` "${node.props.name}"`;
  } else if (node.props.id) {
    line += ` [${node.props.id}]`;
  }

  let output = line + "\n";
  for (const child of node.children) {
    output += printTree(child, indent + "  ");
  }
  return output;
}

export function findNodeById(
  node: DevToolsNode,
  nodeId: string,
): DevToolsNode | null {
  if (node.task?.nodeId === nodeId) return node;
  for (const child of node.children) {
    const found = findNodeById(child, nodeId);
    if (found) return found;
  }
  return null;
}

export function collectTasks(
  node: DevToolsNode,
  out: DevToolsNode[] = [],
): DevToolsNode[] {
  if (node.type === "task") out.push(node);
  for (const child of node.children) {
    collectTasks(child, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Execution state tracking
// ---------------------------------------------------------------------------

export class DevToolsRunStore {
  private _runs = new Map<string, RunExecutionState>();
  private _eventBusListeners: Array<{
    bus: DevToolsEventBus;
    handler: (e: any) => void;
  }> = [];

  constructor(private options: DevToolsRunStoreOptions = {}) {}

  /** Attach to a Smithers EventBus-like source. */
  attachEventBus(bus: DevToolsEventBus): this {
    const handler = (event: any) => this.processEngineEvent(event);
    bus.on("event", handler);
    this._eventBusListeners.push({ bus, handler });
    return this;
  }

  /** Detach all EventBus listeners registered by this store. */
  detachEventBuses(): void {
    for (const { bus, handler } of this._eventBusListeners) {
      bus.removeListener("event", handler);
    }
    this._eventBusListeners = [];
  }

  /** Get execution state for a specific run. */
  getRun(runId: string): RunExecutionState | undefined {
    return this._runs.get(runId);
  }

  /** Get all tracked runs. */
  get runs(): Map<string, RunExecutionState> {
    return this._runs;
  }

  /** Get task execution state by nodeId within a run. Searches all iterations. */
  getTaskState(
    runId: string,
    nodeId: string,
    iteration?: number,
  ): TaskExecutionState | undefined {
    const run = this._runs.get(runId);
    if (!run) return undefined;
    if (typeof iteration === "number") {
      return run.tasks.get(`${nodeId}::${iteration}`);
    }
    for (const task of run.tasks.values()) {
      if (task.nodeId === nodeId) return task;
    }
    return undefined;
  }

  processEngineEvent(event: any): void {
    if (!event || !event.type || !event.runId) return;

    const run = this.ensureRun(event.runId);
    run.events.push(event);

    const verbose = this.options.verbose ?? false;

    switch (event.type) {
      case "RunStarted":
        run.status = "running";
        run.startedAt = event.timestampMs;
        break;

      case "RunFinished":
        run.status = "finished";
        run.finishedAt = event.timestampMs;
        break;

      case "RunFailed":
        run.status = "failed";
        run.finishedAt = event.timestampMs;
        break;

      case "RunCancelled":
        run.status = "cancelled";
        run.finishedAt = event.timestampMs;
        break;

      case "FrameCommitted":
        run.frameNo = event.frameNo;
        break;

      case "NodePending": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        task.status = "pending";
        break;
      }

      case "NodeStarted": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        task.status = "started";
        task.attempt = event.attempt;
        task.startedAt = event.timestampMs;
        if (verbose) {
          console.log(
            `▶️  [smithers-devtools] Task started: ${event.nodeId} (attempt ${event.attempt})`,
          );
        }
        break;
      }

      case "NodeFinished": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        task.status = "finished";
        task.attempt = event.attempt;
        task.finishedAt = event.timestampMs;
        if (verbose) {
          console.log(`✅ [smithers-devtools] Task finished: ${event.nodeId}`);
        }
        break;
      }

      case "NodeFailed": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        task.status = "failed";
        task.attempt = event.attempt;
        task.finishedAt = event.timestampMs;
        task.error = event.error;
        if (verbose) {
          console.log(`❌ [smithers-devtools] Task failed: ${event.nodeId}`);
        }
        break;
      }

      case "NodeCancelled": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        task.status = "cancelled";
        break;
      }

      case "NodeSkipped": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        task.status = "skipped";
        break;
      }

      case "NodeRetrying": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        task.status = "retrying";
        task.attempt = event.attempt;
        break;
      }

      case "NodeWaitingApproval": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        task.status = "waiting-approval";
        run.status = "waiting-approval";
        break;
      }

      case "NodeWaitingEvent": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        task.status = "waiting-event";
        break;
      }

      case "NodeWaitingTimer": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        task.status = "waiting-timer";
        run.status = "waiting-timer";
        break;
      }

      case "ToolCallStarted": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        task.toolCalls.push({ name: event.toolName, seq: event.seq });
        break;
      }

      case "ToolCallFinished": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        const tc = task.toolCalls.find(
          (t) => t.name === event.toolName && t.seq === event.seq,
        );
        if (tc) tc.status = event.status;
        break;
      }
    }

    this.options.onEngineEvent?.(event);
  }

  private ensureRun(runId: string): RunExecutionState {
    let run = this._runs.get(runId);
    if (!run) {
      run = {
        runId,
        status: "running",
        frameNo: 0,
        tasks: new Map(),
        events: [],
      };
      this._runs.set(runId, run);
    }
    return run;
  }

  private ensureTask(
    run: RunExecutionState,
    nodeId: string,
    iteration: number,
  ): TaskExecutionState {
    const key = `${nodeId}::${iteration}`;
    let task = run.tasks.get(key);
    if (!task) {
      task = {
        nodeId,
        iteration,
        status: "pending",
        attempt: 0,
        toolCalls: [],
      };
      run.tasks.set(key, task);
    }
    return task;
  }
}

// ---------------------------------------------------------------------------
// Renderer-agnostic facade for adapters
// ---------------------------------------------------------------------------

export class SmithersDevToolsCore {
  private _lastSnapshot: DevToolsSnapshot | null = null;
  private _runStore: DevToolsRunStore;

  constructor(private options: SmithersDevToolsOptions = {}) {
    this._runStore = new DevToolsRunStore(options);
  }

  captureSnapshot(tree: DevToolsNode | null): DevToolsSnapshot {
    const snapshot = buildSnapshot(tree);
    this._lastSnapshot = snapshot;
    return snapshot;
  }

  emitCommit(
    snapshot: DevToolsSnapshot = this._lastSnapshot ?? buildSnapshot(null),
  ): DevToolsSnapshot {
    this.options.onCommit?.("commit", snapshot);
    return snapshot;
  }

  captureCommit(tree: DevToolsNode | null): DevToolsSnapshot {
    const snapshot = this.captureSnapshot(tree);
    this.emitCommit(snapshot);
    return snapshot;
  }

  emitUnmount(
    snapshot: DevToolsSnapshot = this._lastSnapshot ?? buildSnapshot(null),
  ): DevToolsSnapshot {
    this.options.onCommit?.("unmount", snapshot);
    return snapshot;
  }

  attachEventBus(bus: DevToolsEventBus): this {
    this._runStore.attachEventBus(bus);
    return this;
  }

  detachEventBuses(): void {
    this._runStore.detachEventBuses();
  }

  processEngineEvent(event: any): void {
    this._runStore.processEngineEvent(event);
  }

  getRun(runId: string): RunExecutionState | undefined {
    return this._runStore.getRun(runId);
  }

  get runs(): Map<string, RunExecutionState> {
    return this._runStore.runs;
  }

  getTaskState(
    runId: string,
    nodeId: string,
    iteration?: number,
  ): TaskExecutionState | undefined {
    return this._runStore.getTaskState(runId, nodeId, iteration);
  }

  /** Get the last captured snapshot. */
  get snapshot(): DevToolsSnapshot | null {
    return this._lastSnapshot;
  }

  /** Get the current tree (shorthand). */
  get tree(): DevToolsNode | null {
    return this._lastSnapshot?.tree ?? null;
  }

  /** Pretty-print the current tree to a string. */
  printTree(): string {
    if (!this._lastSnapshot?.tree) return "(no tree captured yet)";
    return printTree(this._lastSnapshot.tree);
  }

  /** Find a node by task nodeId. */
  findTask(nodeId: string): DevToolsNode | null {
    if (!this._lastSnapshot?.tree) return null;
    return findNodeById(this._lastSnapshot.tree, nodeId);
  }

  /** List all tasks in the current tree. */
  listTasks(): DevToolsNode[] {
    if (!this._lastSnapshot?.tree) return [];
    return collectTasks(this._lastSnapshot.tree);
  }
}
