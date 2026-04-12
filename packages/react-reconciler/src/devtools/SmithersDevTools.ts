import { type DevToolsEventBus, type DevToolsNode, type DevToolsSnapshot, type RunExecutionState, type SmithersDevToolsOptions, type TaskExecutionState } from "@smithers/devtools";
export type { DevToolsEventBus, DevToolsEventHandler, DevToolsNode, DevToolsSnapshot, RunExecutionState, SmithersDevToolsOptions, SmithersNodeType, TaskExecutionState, } from "@smithers/devtools";
export declare class SmithersDevTools {
    private options;
    private core;
    private _active;
    private _cleanup;
    constructor(options?: SmithersDevToolsOptions);
    /**
     * Start instrumenting. Installs the React DevTools global hook (if not
     * already present) and begins listening for fiber commits.
     *
     * For best results, call this before `SmithersRenderer` is first imported.
     * If the renderer is already loaded, it will still work as long as the
     * renderer called `injectIntoDevTools` (which it does by default).
     */
    start(): this;
    /** Stop instrumenting and clean up. */
    stop(): void;
    /**
     * Attach to a Smithers EventBus to track task execution state.
     * Listens for SmithersEvent emissions and builds up a run state model.
     */
    attachEventBus(bus: DevToolsEventBus): this;
    /** Get execution state for a specific run. */
    getRun(runId: string): RunExecutionState | undefined;
    /** Get all tracked runs. */
    get runs(): Map<string, RunExecutionState>;
    /** Get task execution state by nodeId within a run. Searches all iterations. */
    getTaskState(runId: string, nodeId: string, iteration?: number): TaskExecutionState | undefined;
    /** Get the last captured snapshot. */
    get snapshot(): DevToolsSnapshot | null;
    /** Get the current tree (shorthand). */
    get tree(): DevToolsNode | null;
    /** Pretty-print the current tree to a string. */
    printTree(): string;
    /** Find a node by task nodeId. */
    findTask(nodeId: string): DevToolsNode | null;
    /** List all tasks in the current tree. */
    listTasks(): DevToolsNode[];
}
