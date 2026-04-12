export type SmithersTaskRuntime = {
    runId: string;
    stepId: string;
    attempt: number;
    iteration: number;
    signal: AbortSignal;
    db: any;
    heartbeat: (data?: unknown) => void;
    lastHeartbeat: unknown | null;
};
export declare function withTaskRuntime<T>(runtime: SmithersTaskRuntime, execute: () => T): T;
export declare function getTaskRuntime(): SmithersTaskRuntime | undefined;
export declare function requireTaskRuntime(): SmithersTaskRuntime;
