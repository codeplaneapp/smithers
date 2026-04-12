import type { SmithersEvent } from "@smithers/observability/SmithersEvent";
export declare function runWorkflow(args: {
    workflowPath: string;
    input: unknown;
    runId?: string;
    baseUrl?: string;
    apiKey?: string;
}): Promise<any>;
export declare function resume(args: {
    workflowPath: string;
    runId: string;
    baseUrl?: string;
    apiKey?: string;
}): Promise<any>;
export declare function approve(args: {
    runId: string;
    nodeId: string;
    iteration?: number;
    note?: string;
    baseUrl?: string;
    apiKey?: string;
}): Promise<any>;
export declare function deny(args: {
    runId: string;
    nodeId: string;
    iteration?: number;
    note?: string;
    baseUrl?: string;
    apiKey?: string;
}): Promise<any>;
export declare function streamEvents(args: {
    runId: string;
    baseUrl?: string;
    apiKey?: string;
}): AsyncIterable<SmithersEvent>;
export declare function getStatus(args: {
    runId: string;
    baseUrl?: string;
    apiKey?: string;
}): Promise<any>;
export declare function getFrames(args: {
    runId: string;
    tail?: number;
    baseUrl?: string;
    apiKey?: string;
}): Promise<any>;
export declare function cancel(args: {
    runId: string;
    baseUrl?: string;
    apiKey?: string;
}): Promise<any>;
export declare function listRuns(args?: {
    limit?: number;
    status?: string;
    baseUrl?: string;
    apiKey?: string;
}): Promise<any>;
