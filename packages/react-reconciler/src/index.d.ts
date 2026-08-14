import * as _smthrs_graph_types from '@smthrs/graph/types';
import { ExtractGraph as ExtractGraph$1, HostNode as HostNode$1 } from '@smthrs/graph/types';
import * as React$1 from 'react';
import React__default from 'react';
import { WorkflowDriver } from '@smthrs/driver';
export { SmithersCtx } from '@smthrs/driver/SmithersCtx';

type SmithersRendererOptions$1 = {
    extractGraph?: ExtractGraph$1;
};

type HostContainer$1 = {
    root: HostNode$1 | null;
    roots?: HostNode$1[];
};

declare class SmithersRenderer {
    /**
     * @param {SmithersRendererOptions} [options]
     */
    constructor(options?: SmithersRendererOptions);
    /** @type {HostContainer} */
    container: HostContainer;
    /** @type {unknown} */
    root: unknown;
    /** @type {ExtractGraph | undefined} */
    extractGraph: ExtractGraph | undefined;
    /**
     * @param {React.ReactElement} element
     * @param {ExtractOptions} [opts]
     * @returns {Promise<WorkflowGraph>}
     */
    render(element: React.ReactElement, opts?: ExtractOptions): Promise<WorkflowGraph>;
    /**
     * @returns {HostNode | null}
     */
    getRoot(): HostNode | null;
    #private;
}
type ExtractGraph = _smthrs_graph_types.ExtractGraph;
type ExtractOptions = _smthrs_graph_types.ExtractOptions;
type HostContainer = HostContainer$1;
type HostNode = _smthrs_graph_types.HostNode;
type React = React$1.default;
type SmithersRendererOptions = SmithersRendererOptions$1;
type WorkflowGraph = _smthrs_graph_types.WorkflowGraph;

/**
 * @template [Schema=unknown]
 * @extends {WorkflowDriver<Schema>}
 */
declare class ReactWorkflowDriver<Schema = unknown> extends WorkflowDriver<Schema> {
}

/**
 * @template Schema
 * @returns {{ SmithersContext: React.Context<SmithersCtx<Schema> | null>, useCtx: () => SmithersCtx<Schema> }}
 */
declare function createSmithersContext<Schema>(): {
    SmithersContext: React__default.Context<SmithersCtx<Schema> | null>;
    useCtx: () => SmithersCtx<Schema>;
};

/** @type {React.Context<SmithersCtx<any> | null>} */
declare const SmithersContext: React__default.Context<SmithersCtx<any> | null>;

export { ReactWorkflowDriver, SmithersContext, SmithersRenderer, createSmithersContext };
