import type React from "react";
import type { RuntimeAdapter } from "@smthrs/driver/RuntimeAdapter";
import type { BrowserRuntimeOptions } from "@smthrs/driver/browser-runtime";
import type { RunResult } from "@smthrs/driver/RunResult";
import type { StoredRunState } from "@smthrs/driver/RuntimeAdapter";
import type { SmithersCtx } from "@smthrs/driver/SmithersCtx";

export type { RuntimeAdapter, BrowserRuntimeOptions };
export { RuntimeCapabilityError, RUNTIME_CAPABILITY_UNAVAILABLE } from "@smthrs/driver/RuntimeCapabilityError";

export type BrowserWorkflow<Schema = unknown> = {
  build: (ctx: SmithersCtx<Schema>) => React.ReactNode;
  zodToKeyName?: Map<unknown, string>;
};

export type BrowserRunOptions = { runId?: string; input?: unknown; signal?: AbortSignal };

export type BrowserSmithers<Schema = unknown> = {
  runtime: RuntimeAdapter;
  run: (runOptions?: BrowserRunOptions) => Promise<RunResult>;
  getRun: (runId: string) => Promise<StoredRunState | undefined>;
  getOutputs: (runId: string) => Promise<Record<string, unknown[]> | undefined>;
};

export declare function defineBrowserWorkflow<Schema = unknown>(
  build: (ctx: SmithersCtx<Schema>) => React.ReactNode,
  opts?: { zodToKeyName?: Map<unknown, string> },
): BrowserWorkflow<Schema>;

export declare function createBrowserRuntime(options?: BrowserRuntimeOptions): RuntimeAdapter;

export declare function createBrowserSmithers<Schema = unknown>(options: {
  workflow: BrowserWorkflow<Schema>;
  runtime?: RuntimeAdapter;
  runtimeOptions?: BrowserRuntimeOptions;
}): BrowserSmithers<Schema>;

export declare function runBrowserWorkflow<Schema = unknown>(
  workflow: BrowserWorkflow<Schema>,
  options?: BrowserRunOptions & { runtime?: RuntimeAdapter },
): Promise<RunResult>;

// Browser-safe workflow primitives — the same production components the Node
// engine uses (`Workflow`/`Sequence`/`Worktree` are runtime-agnostic already;
// `Task` is the browser variant with no CLI-agent-class dependency).
export declare function Task(props: {
  id: string;
  output?: string;
  outputSchema?: unknown;
  agent?: { generate(args?: unknown): Promise<unknown> } | { generate(args?: unknown): Promise<unknown> }[];
  fallbackAgent?: { generate(args?: unknown): Promise<unknown> };
  dependsOn?: string[];
  needs?: Record<string, string>;
  deps?: Record<string, unknown>;
  depsOptional?: boolean;
  children?: React.ReactNode | ((deps: Record<string, unknown>) => unknown);
  [key: string]: unknown;
}): React.ReactElement | null;

export declare function Workflow(props: { name?: string; cache?: unknown; children?: React.ReactNode }): React.ReactElement;

export declare function Sequence(props: { children?: React.ReactNode; label?: string; failurePolicy?: "halt" | "quarantine" }): React.ReactElement | null;

export declare function Worktree(props: {
  id?: string;
  path: string;
  branch?: string;
  baseBranch?: string;
  skipIf?: boolean;
  children?: React.ReactNode;
}): React.ReactElement | null;
