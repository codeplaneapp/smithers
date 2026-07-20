import type React from "react";
import type { CachePolicy } from "@smithers-orchestrator/scheduler/CachePolicy";
import type { RetryPolicy } from "@smithers-orchestrator/scheduler/RetryPolicy";
import type { SmithersWorkflow } from "../SmithersWorkflow.ts";
import type { OutputTarget } from "./OutputTarget.ts";
import type { SandboxRuntime } from "./SandboxRuntime.ts";
import type { SandboxVolumeMount } from "./SandboxVolumeMount.ts";
import type { SandboxWorkspaceSpec } from "./SandboxWorkspaceSpec.ts";
import type { SandboxEgressConfig } from "./SandboxEgressConfig.ts";

export type SandboxProps = {
	id: string;
	/** Child workflow definition. If omitted, createSmithers-bound Sandbox wrappers may provide one. */
	workflow?: SmithersWorkflow<unknown>;
	/** Input passed to the child workflow. */
	input?: unknown;
	output: OutputTarget;
	/** Injectable sandbox provider object or a provider id registered with the sandbox package. */
	provider?: unknown;
	/** @deprecated Prefer provider. Kept for legacy local transports. */
	runtime?: SandboxRuntime;
	allowNetwork?: boolean;
	reviewDiffs?: boolean;
	autoAcceptDiffs?: boolean;
	/** Allow this sandbox to execute while already inside another sandbox. Disabled by default. */
	allowNested?: boolean;
	image?: string;
	env?: Record<string, string>;
	egress?: SandboxEgressConfig;
	ports?: Array<{
		host: number;
		container: number;
	}>;
	volumes?: SandboxVolumeMount[];
	memoryLimit?: string;
	cpuLimit?: string;
	command?: string;
	workspace?: SandboxWorkspaceSpec;
	skipIf?: boolean;
	timeoutMs?: number;
	heartbeatTimeoutMs?: number;
	heartbeatTimeout?: number;
	retries?: number;
	retryPolicy?: RetryPolicy;
	continueOnFail?: boolean;
	cache?: CachePolicy;
	dependsOn?: string[];
	needs?: Record<string, string>;
	label?: string;
	meta?: Record<string, unknown>;
	key?: string;
	children?: React.ReactNode;
};
