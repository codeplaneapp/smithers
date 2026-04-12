import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersEvent } from "@smithers/observability/SmithersEvent";
export type RevertOptions = {
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    onProgress?: (event: SmithersEvent) => void;
};
export type RevertResult = {
    success: boolean;
    error?: string;
    jjPointer?: string;
};
export declare function revertToAttempt(adapter: SmithersDb, opts: RevertOptions): Promise<RevertResult>;
