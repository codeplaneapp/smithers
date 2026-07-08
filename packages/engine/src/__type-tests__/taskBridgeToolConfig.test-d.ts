import type { TaskBridgeToolConfig } from "../effect/TaskBridgeToolConfig.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
type Assert<T extends true> = T;

const fullConfig = {
  rootDir: "/tmp",
  allowNetwork: false,
  maxOutputBytes: 1024,
  toolTimeoutMs: 1000,
  agentPreflightCache: new WeakMap<object, Promise<void>>(),
  traceContext: {
    workflowPath: null,
    workflowHash: null,
    logDir: undefined,
    annotations: undefined,
  },
} satisfies TaskBridgeToolConfig;

type _WorkflowPathIsNullableString = Assert<
  Equal<
    NonNullable<TaskBridgeToolConfig["traceContext"]>["workflowPath"],
    string | null
  >
>;

const _malformedTraceContext = {
  rootDir: "/tmp",
  allowNetwork: false,
  maxOutputBytes: 1024,
  toolTimeoutMs: 1000,
  traceContext: {
    // @ts-expect-error workflowPath must be string | null, not a number.
    workflowPath: 123,
    workflowHash: null,
  },
} satisfies TaskBridgeToolConfig;

void fullConfig;
void _malformedTraceContext;
