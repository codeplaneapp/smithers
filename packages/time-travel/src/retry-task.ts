import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersEvent } from "@smithers/observability/SmithersEvent";
export type RetryTaskOptions = {
    runId: string;
    nodeId: string;
    iteration?: number;
    resetDependents?: boolean;
    force?: boolean;
    onProgress?: (event: SmithersEvent) => void;
};
export type RetryTaskResult = {
    success: boolean;
    resetNodes: string[];
    error?: string;
};
export declare function retryTask(adapter: SmithersDb, opts: RetryTaskOptions): Promise<RetryTaskResult>;
