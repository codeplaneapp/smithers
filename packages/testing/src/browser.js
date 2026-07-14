// src/browser.ts
import { RuntimeCapabilityError, RUNTIME_CAPABILITY_UNAVAILABLE } from "@smithers-orchestrator/driver/RuntimeCapabilityError";
function assertCapabilityError(capability, operation, action) {
  try {
    action();
  } catch (error) {
    if (error instanceof RuntimeCapabilityError && error.code === RUNTIME_CAPABILITY_UNAVAILABLE && error.capability === capability && error.operation === operation) {
      return error;
    }
    throw error;
  }
  throw new Error(`Expected a RuntimeCapabilityError for ${capability}.${operation}(), but the call did not throw`);
}
async function assertAsyncCapabilityError(capability, operation, action) {
  try {
    await action();
  } catch (error) {
    if (error instanceof RuntimeCapabilityError && error.code === RUNTIME_CAPABILITY_UNAVAILABLE && error.capability === capability && error.operation === operation) {
      return error;
    }
    throw error;
  }
  throw new Error(`Expected a RuntimeCapabilityError for ${capability}.${operation}(), but the call did not reject`);
}
async function runConformanceWorkflow(smithers, runOptions = {}) {
  const result = await smithers.run(runOptions);
  if (result.status !== "finished") {
    throw new Error(`Expected a finished run, got status "${result.status}": ${JSON.stringify(result.error ?? null)}`);
  }
  const [stored, outputs] = await Promise.all([smithers.getRun(result.runId), smithers.getOutputs(result.runId)]);
  return { result, stored, outputs };
}
export {
  assertAsyncCapabilityError,
  assertCapabilityError,
  runConformanceWorkflow
};
