import React from "react";
import type { SmithersWorkflow } from "@smithers/components/SmithersWorkflow";
import type { SmithersCtx } from "@smithers/driver/SmithersCtx";
import type { AgentLike } from "@smithers/agents/AgentLike";
import type { OutputSnapshot } from "@smithers/driver/OutputSnapshot";
import type { z } from "zod";
export type SerializedCtx = {
    runId: string;
    iteration: number;
    iterations: Record<string, number>;
    input: any;
    outputs: OutputSnapshot;
};
export type HostNodeJson = {
    kind: "element";
    tag: string;
    props: Record<string, string>;
    rawProps: Record<string, any>;
    children: HostNodeJson[];
} | {
    kind: "text";
    text: string;
};
export type ExternalSmithersConfig<S extends Record<string, z.ZodObject<any>>> = {
    schemas: S;
    agents: Record<string, AgentLike>;
    /** Synchronous build function that returns a HostNode JSON tree. */
    buildFn: (ctx: SerializedCtx) => HostNodeJson;
    dbPath?: string;
};
/**
 * Serialize a SmithersCtx into a plain JSON-safe object for external processes.
 */
export declare function serializeCtx(ctx: SmithersCtx<any>): SerializedCtx;
/**
 * Convert a HostNodeJson tree to React elements, resolving string agent references.
 */
export declare function hostNodeToReact(node: HostNodeJson, agents: Record<string, AgentLike>): React.ReactNode;
/**
 * Create a SmithersWorkflow from an external build function.
 *
 * Schemas and agents are defined in TS. The build function produces a HostNode JSON tree
 * that maps 1:1 to what the JSX renderer would produce.
 */
export declare function createExternalSmithers<S extends Record<string, z.ZodObject<any>>>(config: ExternalSmithersConfig<S>): SmithersWorkflow<S> & {
    tables: Record<string, any>;
    cleanup: () => void;
};
