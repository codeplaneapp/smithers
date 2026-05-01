import type { SandboxRuntime } from "./SandboxRuntime.ts";

export type SandboxWorkflow = {
	db?: unknown;
	build: (ctx: unknown) => unknown;
	opts?: Record<string, unknown>;
	schemaRegistry?: unknown;
	zodToKeyName?: unknown;
};

export type SandboxChildWorkflowDefinition =
	| SandboxWorkflow
	| (() => SandboxWorkflow | unknown);

export type ExecuteSandboxChildWorkflowOptions = {
	workflow: SandboxChildWorkflowDefinition;
	input?: unknown;
	runId?: string;
	parentRunId?: string;
	rootDir?: string;
	allowNetwork?: boolean;
	maxOutputBytes?: number;
	toolTimeoutMs?: number;
	workflowPath?: string;
	signal?: AbortSignal;
};

export type ExecuteSandboxChildWorkflow = (
	parentWorkflow: SandboxWorkflow | undefined,
	options: ExecuteSandboxChildWorkflowOptions,
) => Promise<{ runId: string; status: string; output: unknown }>;

export type ExecuteSandboxOptions = {
    parentWorkflow?: SandboxWorkflow;
    sandboxId: string;
    runtime?: SandboxRuntime;
    workflow: SandboxChildWorkflowDefinition;
    executeChildWorkflow: ExecuteSandboxChildWorkflow;
    input?: unknown;
    rootDir: string;
    allowNetwork: boolean;
    maxOutputBytes: number;
    toolTimeoutMs: number;
    reviewDiffs?: boolean;
    autoAcceptDiffs?: boolean;
    config?: Record<string, unknown>;
};
