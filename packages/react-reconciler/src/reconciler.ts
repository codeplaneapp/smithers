import type React from "react";
import type { ExtractGraph, ExtractOptions, HostNode, WorkflowGraph } from "@smithers/graph/types";
export type HostContainer = {
    root: HostNode | null;
};
export type SmithersRendererOptions = {
    extractGraph?: ExtractGraph;
};
export declare class SmithersRenderer {
    private readonly container;
    private readonly root;
    private readonly extractGraph?;
    constructor(options?: SmithersRendererOptions);
    render(element: React.ReactElement, opts?: ExtractOptions): Promise<WorkflowGraph>;
    getRoot(): HostNode | null;
}
