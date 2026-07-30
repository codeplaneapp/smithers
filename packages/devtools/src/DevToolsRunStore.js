/** @typedef {import("./DevToolsEngineEvent.ts").DevToolsEngineEvent} DevToolsEngineEvent */
/** @typedef {import("./DevToolsEventBus.ts").DevToolsEventBus} DevToolsEventBus */
/** @typedef {import("./DevToolsRunStoreOptions.ts").DevToolsRunStoreOptions} DevToolsRunStoreOptions */
/** @typedef {import("./RunExecutionState.ts").RunExecutionState} RunExecutionState */
/** @typedef {import("./TaskExecutionState.ts").TaskExecutionState} TaskExecutionState */

const TERMINAL_RUN_STATUSES = new Set(["finished", "failed", "cancelled"]);
const TERMINAL_TASK_STATUSES = new Set(["finished", "failed", "cancelled", "skipped"]);

/** Default cap on retained runs before the oldest is FIFO-evicted. */
const DEFAULT_MAX_RUNS_RETAINED = 500;
/** Default cap on retained events per run before the oldest are FIFO-evicted. */
const DEFAULT_MAX_EVENTS_PER_RUN = 10000;
/** Default cap on retained task states per run before the oldest are FIFO-evicted. */
const DEFAULT_MAX_TASKS_PER_RUN = 5000;
/** Default cap on retained tool calls per task before the oldest are FIFO-evicted. */
const DEFAULT_MAX_TOOL_CALLS_PER_TASK = 1000;

/**
 * Normalize a retention cap. A finite value >= 1 is used as-is; Infinity
 * disables eviction; anything else falls back to the default.
 * @param {number | undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function resolveCap(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || Number.isNaN(value) || value < 1) return fallback;
  return value;
}
/**
 * Run-level waiting statuses that a NodeWaitingApproval/NodeWaitingTimer event
 * can raise. These must clear back to "running" once the blocking task resumes.
 */
const RUN_WAITING_STATUSES = new Set(["waiting-approval", "waiting-timer"]);

/**
 * @param {RunExecutionState} run
 */
function isTerminalRun(run) {
  return TERMINAL_RUN_STATUSES.has(run.status);
}

/**
 * @param {TaskExecutionState} task
 */
function isTerminalTask(task) {
  return TERMINAL_TASK_STATUSES.has(task.status);
}

/**
 * Recompute a run's waiting status after a task transitions out of a waiting
 * state. Only acts when the run is currently parked in a run-level waiting
 * status (waiting-approval / waiting-timer) and is not terminal: if no task
 * remains in a run-blocking waiting state, the run resumes to "running". A
 * still-waiting sibling keeps the run parked (and may downgrade
 * waiting-timer -> waiting-approval as appropriate). The engine re-emits a
 * fresh waiting event if the run blocks again.
 * @param {RunExecutionState} run
 * @returns {void}
 */
function refreshRunWaitingStatus(run) {
  if (isTerminalRun(run) || !RUN_WAITING_STATUSES.has(run.status)) {
    return;
  }
  let blocking;
  for (const task of run.tasks.values()) {
    if (task.status === "waiting-approval") {
      // Approval is the strongest block; nothing can override it.
      blocking = "waiting-approval";
      break;
    }
    if (task.status === "waiting-timer") {
      blocking = "waiting-timer";
    }
  }
  run.status = blocking ?? "running";
}

export class DevToolsRunStore {
  /** @type {DevToolsRunStoreOptions} */
  options;
  /** @type {Map<string, RunExecutionState>} */
  _runs = new Map();
  /** @type {Array<{ bus: DevToolsEventBus; handler: (event: DevToolsEngineEvent) => void }>} */
  _eventBusListeners = [];
  /** @type {number} */
  _maxRunsRetained;
  /** @type {number} */
  _maxEventsPerRun;
  /** @type {number} */
  _maxTasksPerRun;
  /** @type {number} */
  _maxToolCallsPerTask;
  /**
   * @param {DevToolsRunStoreOptions} [options]
   */
  constructor(options = {}) {
    this.options = options;
    this._maxRunsRetained = resolveCap(options.maxRunsRetained, DEFAULT_MAX_RUNS_RETAINED);
    this._maxEventsPerRun = resolveCap(options.maxEventsPerRun, DEFAULT_MAX_EVENTS_PER_RUN);
    this._maxTasksPerRun = resolveCap(options.maxTasksPerRun, DEFAULT_MAX_TASKS_PER_RUN);
    this._maxToolCallsPerTask = resolveCap(options.maxToolCallsPerTask, DEFAULT_MAX_TOOL_CALLS_PER_TASK);
  }
  /**
   * Attach to a Smithers EventBus-like source.
   * @param {DevToolsEventBus} bus
   * @returns {this}
   */
  attachEventBus(bus) {
    /**
     * @param {DevToolsEngineEvent} event
     */
    const handler = (event) => this.processEngineEvent(event);
    bus.on("event", handler);
    this._eventBusListeners.push({ bus, handler });
    return this;
  }
  /**
   * Detach all EventBus listeners registered by this store.
   * @returns {void}
   */
  detachEventBuses() {
    for (const { bus, handler } of this._eventBusListeners) {
      bus.removeListener("event", handler);
    }
    this._eventBusListeners = [];
  }
  /**
   * Get execution state for a specific run.
   * @param {string} runId
   * @returns {RunExecutionState | undefined}
   */
  getRun(runId) {
    return this._runs.get(runId);
  }
  /**
   * Get all tracked runs.
   * @returns {Map<string, RunExecutionState>}
   */
  get runs() {
    return this._runs;
  }
  /**
   * Get task execution state by nodeId within a run. Searches all iterations.
   * @param {string} runId
   * @param {string} nodeId
   * @param {number} [iteration]
   * @returns {TaskExecutionState | undefined}
   */
  getTaskState(runId, nodeId, iteration) {
    const run = this._runs.get(runId);
    if (!run) return undefined;
    if (typeof iteration === "number") {
      return run.tasks.get(`${nodeId}::${iteration}`);
    }
    let latest;
    for (const task of run.tasks.values()) {
      if (task.nodeId === nodeId && (!latest || task.iteration > latest.iteration)) {
        latest = task;
      }
    }
    return latest;
  }
  /**
   * @param {DevToolsEngineEvent} event
   * @returns {void}
   */
  processEngineEvent(event) {
    if (!event || !event.type || !event.runId) return;
    const run = this.ensureRun(event.runId);
    run.events.push(event);
    if (run.events.length > this._maxEventsPerRun) {
      run.events.splice(0, run.events.length - this._maxEventsPerRun);
    }
    const verbose = this.options.verbose ?? false;
    switch (event.type) {
      case "RunStarted":
        if (isTerminalRun(run)) break;
        run.status = "running";
        run.startedAt = event.timestampMs;
        break;
      case "RunFinished":
        if (isTerminalRun(run)) break;
        run.status = "finished";
        run.finishedAt = event.timestampMs;
        if (typeof event.failedChildren === "number" && event.failedChildren > 0) {
          run.failedChildren = event.failedChildren;
          run.failedChildKeys = Array.isArray(event.failedChildKeys) ? [...event.failedChildKeys] : [];
        }
        break;
      case "RunFailed":
        if (isTerminalRun(run)) break;
        run.status = "failed";
        run.finishedAt = event.timestampMs;
        break;
      case "RunCancelled":
        if (isTerminalRun(run)) break;
        run.status = "cancelled";
        run.finishedAt = event.timestampMs;
        break;
      case "FrameCommitted":
        run.frameNo = event.frameNo;
        break;
      case "NodePending": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        if (isTerminalTask(task)) break;
        task.status = "pending";
        refreshRunWaitingStatus(run);
        break;
      }
      case "NodeStarted": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        if (isTerminalTask(task)) break;
        task.status = "started";
        task.attempt = event.attempt;
        task.startedAt = event.timestampMs;
        task.finishedAt = undefined;
        task.error = undefined;
        refreshRunWaitingStatus(run);
        if (verbose) {
          console.log(`▶️  [smithers-devtools] Task started: ${event.nodeId} (attempt ${event.attempt})`);
        }
        break;
      }
      case "NodeFinished": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        if (isTerminalTask(task)) break;
        task.status = "finished";
        task.attempt = event.attempt;
        task.finishedAt = event.timestampMs;
        refreshRunWaitingStatus(run);
        if (verbose) {
          console.log(`✅ [smithers-devtools] Task finished: ${event.nodeId}`);
        }
        break;
      }
      case "NodeFailed": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        if (isTerminalTask(task)) break;
        task.status = "failed";
        task.attempt = event.attempt;
        task.finishedAt = event.timestampMs;
        task.error = event.error;
        refreshRunWaitingStatus(run);
        if (verbose) {
          console.log(`❌ [smithers-devtools] Task failed: ${event.nodeId}`);
        }
        break;
      }
      case "NodeCancelled": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        if (isTerminalTask(task)) break;
        task.status = "cancelled";
        refreshRunWaitingStatus(run);
        break;
      }
      case "NodeSkipped": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        if (isTerminalTask(task)) break;
        task.status = "skipped";
        refreshRunWaitingStatus(run);
        break;
      }
      case "NodeRetrying": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        // Deliberately no isTerminalTask guard: NodeRetrying is the
        // explicit transition OUT of a terminal failed task (retry-task).
        task.status = "retrying";
        task.attempt = event.attempt;
        task.finishedAt = undefined;
        task.error = undefined;
        refreshRunWaitingStatus(run);
        break;
      }
      case "NodeWaitingApproval": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        if (isTerminalTask(task)) break;
        task.status = "waiting-approval";
        if (!isTerminalRun(run)) {
          run.status = "waiting-approval";
        }
        break;
      }
      case "NodeWaitingEvent": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        if (isTerminalTask(task)) break;
        task.status = "waiting-event";
        break;
      }
      case "NodeWaitingTimer": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        if (isTerminalTask(task)) break;
        task.status = "waiting-timer";
        if (!isTerminalRun(run)) {
          run.status = "waiting-timer";
        }
        break;
      }
      case "ToolCallStarted": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        // Upsert by (name, seq): a reconnect-after-seq replay re-feeds the
        // whole log, so a blind push would duplicate every tool call and
        // strand the copies without a status (ToolCallFinished below only
        // matches the first). Deliberately no isTerminalTask guard — the
        // dedup already makes replay converge, and a late tool call on a
        // finished task is still real data worth keeping.
        const existing = task.toolCalls.find((t) => t.name === event.toolName && t.seq === event.seq);
        if (!existing) {
          task.toolCalls.push({ name: event.toolName, seq: event.seq });
          // FIFO-evict the oldest tool calls so a long-lived agent task
          // emitting thousands of calls can't grow the store forever the
          // way the capped runs/events/tasks already can't.
          if (task.toolCalls.length > this._maxToolCallsPerTask) {
            task.toolCalls.splice(0, task.toolCalls.length - this._maxToolCallsPerTask);
          }
        }
        break;
      }
      case "ToolCallFinished": {
        const task = this.ensureTask(run, event.nodeId, event.iteration);
        const tc = task.toolCalls.find((t) => t.name === event.toolName && t.seq === event.seq);
        if (tc) tc.status = event.status;
        break;
      }
    }
    this.options.onEngineEvent?.(event);
  }
  /**
   * @param {string} runId
   * @returns {RunExecutionState}
   */
  ensureRun(runId) {
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
      // FIFO-evict oldest runs (Map preserves insertion order) so a live
      // bus with unbounded distinct runs can't grow the store forever.
      while (this._runs.size > this._maxRunsRetained) {
        const oldest = this._runs.keys().next().value;
        if (oldest === undefined) break;
        this._runs.delete(oldest);
      }
    }
    return run;
  }
  /**
   * @param {RunExecutionState} run
   * @param {string} nodeId
   * @param {number} iteration
   * @returns {TaskExecutionState}
   */
  ensureTask(run, nodeId, iteration) {
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
      // FIFO-evict oldest task states (Map preserves insertion order) so a
      // looping run — one entry per (nodeId, iteration) — can't grow the
      // store forever the way the capped runs/events already can't.
      while (run.tasks.size > this._maxTasksPerRun) {
        const oldest = run.tasks.keys().next().value;
        if (oldest === undefined) break;
        run.tasks.delete(oldest);
      }
    }
    return task;
  }
}
