/// <reference path="../types/bun-test-shim.d.ts" />
import { RuntimeCapabilityError } from '@smithers-orchestrator/driver/RuntimeCapabilityError';
export { RuntimeConformanceLane, RuntimeConformanceResult, assertRuntimeConformance, isRuntimeCapabilityError } from './runtimeConformance.js';

type BrowserConformanceSmithers = {
    run(options?: {
        runId?: string;
        input?: unknown;
        signal?: AbortSignal;
    }): Promise<{
        runId: string;
        status: string;
        output?: unknown;
        error?: unknown;
    }>;
    getRun(runId: string): Promise<unknown>;
    getOutputs(runId: string): Promise<Record<string, unknown[]> | undefined>;
};
/**
 * Call a synchronous capability operation and assert it fails closed with a
 * typed `RuntimeCapabilityError` naming the exact capability/operation —
 * e.g. `runtime.worktree.resolve`.
 */
declare function assertCapabilityError(capability: string, operation: string, action: () => unknown): RuntimeCapabilityError;
/**
 * Call an asynchronous (Promise-returning) capability operation and assert it
 * rejects with a typed `RuntimeCapabilityError` naming the exact
 * capability/operation — e.g. `runtime.filesystem.readFile`.
 */
declare function assertAsyncCapabilityError(capability: string, operation: string, action: () => Promise<unknown>): Promise<RuntimeCapabilityError>;
/**
 * Run a `createBrowserSmithers()`/`createSmithers()`-shaped instance to
 * completion and return the terminal result alongside the durably persisted
 * run record and every completed task's output snapshot — proving storage
 * threading, not just the in-memory `RunResult`.
 */
declare function runConformanceWorkflow(smithers: BrowserConformanceSmithers, runOptions?: {
    runId?: string;
    input?: unknown;
    signal?: AbortSignal;
}): Promise<{
    result: Awaited<ReturnType<BrowserConformanceSmithers["run"]>>;
    stored: unknown;
    outputs: Record<string, unknown[]> | undefined;
}>;

export { type BrowserConformanceSmithers, assertAsyncCapabilityError, assertCapabilityError, runConformanceWorkflow };
