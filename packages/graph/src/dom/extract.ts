import type { XmlNode } from "@smithers/graph/XmlNode";
import type { TaskDescriptor } from "@smithers/graph/TaskDescriptor";
export type HostNode = HostElement | HostText;
export type HostElement = {
    kind: "element";
    tag: string;
    props: Record<string, string>;
    rawProps: Record<string, any>;
    children: HostNode[];
};
export type HostText = {
    kind: "text";
    text: string;
};
export type ExtractResult = {
    xml: XmlNode | null;
    tasks: TaskDescriptor[];
    mountedTaskIds: string[];
};
export type ExtractOptions = {
    ralphIterations?: Map<string, number> | Record<string, number>;
    defaultIteration?: number;
    /** Base directory for resolving relative Worktree paths */
    baseRootDir?: string;
    workflowPath?: string | null;
};
export declare function extractFromHost(root: HostNode | null, opts?: ExtractOptions): ExtractResult;
