import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersEvent } from "@smithers/observability/SmithersEvent";
export type TimeTravelOptions = {
    runId: string;
    nodeId: string;
    iteration?: number;
    attempt?: number;
    resetDependents?: boolean;
    restoreVcs?: boolean;
    onProgress?: (event: SmithersEvent) => void;
};
export type TimeTravelResult = {
    success: boolean;
    jjPointer?: string;
    vcsRestored: boolean;
    resetNodes: string[];
    error?: string;
};
export declare function timeTravel(adapter: SmithersDb, opts: TimeTravelOptions): Promise<TimeTravelResult>;
