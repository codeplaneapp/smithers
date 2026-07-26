// Browser-safe runtime-conformance helper. Deliberately does NOT import the
// main `@smithers-orchestrator/testing` barrel (`index.ts`) — that barrel
// pulls in Node-heavy helpers (fakeAgent's CLI process mocking, simulate.ts,
// etc.) that would defeat the point of a bundle importable by a browser
// fixture. This module only ever imports `@smithers-orchestrator/driver`
// subpaths, which are themselves runtime-portable.
import {
  RuntimeCapabilityError,
  RUNTIME_CAPABILITY_UNAVAILABLE,
} from "@smithers-orchestrator/driver/RuntimeCapabilityError";

export type BrowserConformanceSmithers = {
  run(options?: { runId?: string; input?: unknown; signal?: AbortSignal }): Promise<{
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
export function assertCapabilityError(
  capability: string,
  operation: string,
  action: () => unknown,
): RuntimeCapabilityError {
  try {
    action();
  } catch (error) {
    if (
      error instanceof RuntimeCapabilityError &&
      error.code === RUNTIME_CAPABILITY_UNAVAILABLE &&
      error.capability === capability &&
      error.operation === operation
    ) {
      return error;
    }
    throw error;
  }
  throw new Error(`Expected a RuntimeCapabilityError for ${capability}.${operation}(), but the call did not throw`);
}

/**
 * Call an asynchronous (Promise-returning) capability operation and assert it
 * rejects with a typed `RuntimeCapabilityError` naming the exact
 * capability/operation — e.g. `runtime.filesystem.readFile`.
 */
export async function assertAsyncCapabilityError(
  capability: string,
  operation: string,
  action: () => Promise<unknown>,
): Promise<RuntimeCapabilityError> {
  try {
    await action();
  } catch (error) {
    if (
      error instanceof RuntimeCapabilityError &&
      error.code === RUNTIME_CAPABILITY_UNAVAILABLE &&
      error.capability === capability &&
      error.operation === operation
    ) {
      return error;
    }
    throw error;
  }
  throw new Error(`Expected a RuntimeCapabilityError for ${capability}.${operation}(), but the call did not reject`);
}

/**
 * Run a `createBrowserSmithers()`/`createSmithers()`-shaped instance to
 * completion and return the terminal result alongside the durably persisted
 * run record and every completed task's output snapshot — proving storage
 * threading, not just the in-memory `RunResult`.
 */
export async function runConformanceWorkflow(
  smithers: BrowserConformanceSmithers,
  runOptions: { runId?: string; input?: unknown; signal?: AbortSignal } = {},
): Promise<{
  result: Awaited<ReturnType<BrowserConformanceSmithers["run"]>>;
  stored: unknown;
  outputs: Record<string, unknown[]> | undefined;
}> {
  const result = await smithers.run(runOptions);
  if (result.status !== "finished") {
    throw new Error(`Expected a finished run, got status "${result.status}": ${JSON.stringify(result.error ?? null)}`);
  }
  const [stored, outputs] = await Promise.all([smithers.getRun(result.runId), smithers.getOutputs(result.runId)]);
  return { result, stored, outputs };
}

export { assertRuntimeConformance, isRuntimeCapabilityError } from "./runtimeConformance.js";
export type { RuntimeConformanceLane, RuntimeConformanceResult } from "./runtimeConformance.js";
