import { forkRun as forkRunEffect } from "./forkRunEffect";
import { getBranchInfo as getBranchInfoEffect } from "./getBranchInfoEffect";
import { listBranches as listBranchesEffect } from "./listBranchesEffect";
export { forkRunEffect, getBranchInfoEffect, listBranchesEffect, };
export declare function forkRun(...args: Parameters<typeof forkRunEffect>): Promise<{
    runId: string;
    branch: import("..").BranchInfo;
    snapshot: import("..").Snapshot;
}>;
export declare function listBranches(...args: Parameters<typeof listBranchesEffect>): Promise<import("..").BranchInfo[]>;
export declare function getBranchInfo(...args: Parameters<typeof getBranchInfoEffect>): Promise<import("..").BranchInfo | undefined>;
