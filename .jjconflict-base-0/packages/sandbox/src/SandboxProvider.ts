import type { SandboxChildWorkflowDefinition, SandboxWorkflow, ExecuteSandboxChildWorkflow } from "./ExecuteSandboxOptions.ts";
import type { SandboxEgressConfig } from "./SandboxEgressConfig.ts";

export type SandboxBundleStatus = "finished" | "failed" | "cancelled";

export type SandboxDiffBundleLike = {
	seq: number;
	baseRef: string;
	patches: Array<{
		path: string;
		operation: "add" | "modify" | "delete";
		diff: string;
		binaryContent?: string;
	}>;
};

export type SandboxProviderRequest = {
	runId: string;
	sandboxId: string;
	input?: unknown;
	rootDir: string;
	requestBundlePath: string;
	resultBundlePath: string;
	workflow: SandboxChildWorkflowDefinition;
	parentWorkflow?: SandboxWorkflow;
	executeChildWorkflow: ExecuteSandboxChildWorkflow;
	allowNetwork: boolean;
	maxOutputBytes: number;
	toolTimeoutMs: number;
	egress?: SandboxEgressConfig;
	config: Record<string, unknown>;
	signal?: AbortSignal;
	heartbeat: (data?: unknown) => void;
};

export type SandboxProviderResult =
	| {
			bundlePath: string;
			remoteRunId?: string;
			workspaceId?: string;
			containerId?: string;
	  }
	| {
			status: SandboxBundleStatus;
			output?: unknown;
			outputs?: unknown;
			runId?: string;
			remoteRunId?: string;
			workspaceId?: string;
			containerId?: string;
			diffBundle?: SandboxDiffBundleLike;
			patches?: Array<{ path: string; content: string }>;
			artifacts?: Array<{ path: string; content: string }>;
			streamLogPath?: string | null;
	  };

export type SandboxProvider = {
	id: string;
	run: (request: SandboxProviderRequest) => Promise<SandboxProviderResult> | SandboxProviderResult;
	cleanup?: (request: SandboxProviderRequest) => Promise<void> | void;
};
