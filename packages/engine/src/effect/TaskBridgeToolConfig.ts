import type { TaskTraceContext } from "./TaskTraceContext.ts";

export type TaskBridgeToolConfig = {
	rootDir: string;
	allowNetwork: boolean;
	maxOutputBytes: number;
	toolTimeoutMs: number;
	agentPreflightCache?: WeakMap<object, Promise<void>>;
	traceContext?: TaskTraceContext;
};
