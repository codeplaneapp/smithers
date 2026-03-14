import { AsyncLocalStorage } from "node:async_hooks";

export type SmithersTaskRuntime = {
  runId: string;
  stepId: string;
  attempt: number;
  iteration: number;
  signal: AbortSignal;
  db: any;
};

const storage = new AsyncLocalStorage<SmithersTaskRuntime>();

export function withTaskRuntime<T>(
  runtime: SmithersTaskRuntime,
  execute: () => T,
): T {
  return storage.run(runtime, execute);
}

export function getTaskRuntime(): SmithersTaskRuntime | undefined {
  return storage.getStore();
}

export function requireTaskRuntime(): SmithersTaskRuntime {
  const runtime = storage.getStore();
  if (!runtime) {
    throw new Error(
      "Smithers task runtime is only available while a builder step is executing.",
    );
  }
  return runtime;
}
