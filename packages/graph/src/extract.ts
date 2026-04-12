import type { ExtractOptions, HostNode, WorkflowGraph } from "./types.ts";
export declare function extractGraph(root: HostNode | null, opts?: ExtractOptions): WorkflowGraph;
export declare const extractFromHost: typeof extractGraph;
