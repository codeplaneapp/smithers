import { loadVcsTag as loadVcsTagEffect } from "./loadVcsTagEffect";
import { rerunAtRevision as rerunAtRevisionEffect } from "./rerunAtRevisionEffect";
import { resolveWorkflowAtRevision as resolveWorkflowAtRevisionEffect } from "./resolveWorkflowAtRevisionEffect";
import { tagSnapshotVcs as tagSnapshotVcsEffect } from "./tagSnapshotVcsEffect";
export type { VcsTag } from "./VcsTag";
export { loadVcsTagEffect, rerunAtRevisionEffect, resolveWorkflowAtRevisionEffect, tagSnapshotVcsEffect, };
export declare function tagSnapshotVcs(...args: Parameters<typeof tagSnapshotVcsEffect>): Promise<import("./VcsTag").VcsTag | null>;
export declare function loadVcsTag(...args: Parameters<typeof loadVcsTagEffect>): Promise<import("./VcsTag").VcsTag | undefined>;
export declare function resolveWorkflowAtRevision(...args: Parameters<typeof resolveWorkflowAtRevisionEffect>): Promise<{
    workspacePath: string;
    vcsPointer: string;
} | null>;
export declare function rerunAtRevision(...args: Parameters<typeof rerunAtRevisionEffect>): Promise<{
    restored: boolean;
    vcsPointer: string | null;
    error?: string;
}>;
