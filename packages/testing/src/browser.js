// src/browser.ts
import {
  RuntimeCapabilityError as RuntimeCapabilityError2,
  RUNTIME_CAPABILITY_UNAVAILABLE as RUNTIME_CAPABILITY_UNAVAILABLE2
} from "@smithers-orchestrator/driver/RuntimeCapabilityError";

// src/runtimeConformance.js
import {
  RuntimeCapabilityError,
  RUNTIME_CAPABILITY_UNAVAILABLE
} from "@smithers-orchestrator/driver/RuntimeCapabilityError";
function fail(message) {
  throw new Error(`runtime conformance: ${message}`);
}
function expect(condition, message) {
  if (!condition) fail(message);
}
function assertRuntimeConformance(proof, lane) {
  expect(proof.result?.status === "finished", `run did not finish (${proof.result?.status ?? "missing result"})`);
  expect(proof.stored?.status === "finished", "terminal run state was not persisted");
  expect(
    proof.result.output && proof.result.output.answer === 43,
    "dependent output was not propagated"
  );
  expect(proof.generateCalls === 1, `agent was called ${proof.generateCalls} times`);
  expect(
    proof.outputs?.agent_output?.[0] && proof.outputs.agent_output[0].answer === 42,
    "agent output was not persisted"
  );
  expect(
    proof.outputs?.dependent_output?.[0] && proof.outputs.dependent_output[0].answer === 43,
    "dependent output was not persisted"
  );
  expect(
    proof.finishedSaveCount === 1,
    `run persisted "finished" state ${proof.finishedSaveCount} times, expected exactly once`
  );
  expect(
    Array.isArray(proof.runIds) && proof.runIds.length >= 2,
    "expected run ids from at least two independent runs"
  );
  for (const runId of proof.runIds) {
    expect(
      /^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId),
      `run id "${runId}" is not UUID-shaped`
    );
  }
  expect(
    new Set(proof.runIds).size === proof.runIds.length,
    "generated run ids were not unique across independent runs"
  );
  expect(proof.schemaRejection?.rejected === true, "engine did not reject agent output that failed its outputSchema");
  expect(
    proof.schemaRejection?.engineOwned === true,
    "schema rejection was not attributable to engine-owned OUTPUT_SCHEMA_VALIDATION_FAILED enforcement"
  );
  for (const capability of ["filesystem", "subprocess", "sandbox", "worktree"]) {
    const details = proof.capabilityProof[capability];
    expect(details?.runtime === "browser", `missing typed unsupported capability error for ${capability}`);
    expect(details.capability === capability, `wrong capability in ${capability} error`);
    expect(details.operation.length > 0, `missing operation in ${capability} error`);
  }
  const requiredHostChecks = {
    Browser: [],
    "Cloudflare Workers": ["fetchLifecycle", "binding"],
    Vercel: ["fetchLifecycle", "vercelRuntime"],
    "Node.js": ["filesystem", "subprocess"],
    Bun: ["filesystem", "subprocess"]
  };
  for (const check of requiredHostChecks[lane]) expect(proof.host[check] === true, `host check ${check} did not pass`);
  return proof;
}
function isRuntimeCapabilityError(error, capability, operation) {
  return error instanceof RuntimeCapabilityError && error.code === RUNTIME_CAPABILITY_UNAVAILABLE && error.capability === capability && error.operation === operation;
}

// src/browser.ts
function assertCapabilityError(capability, operation, action) {
  try {
    action();
  } catch (error) {
    if (error instanceof RuntimeCapabilityError2 && error.code === RUNTIME_CAPABILITY_UNAVAILABLE2 && error.capability === capability && error.operation === operation) {
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
    if (error instanceof RuntimeCapabilityError2 && error.code === RUNTIME_CAPABILITY_UNAVAILABLE2 && error.capability === capability && error.operation === operation) {
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
  assertRuntimeConformance,
  isRuntimeCapabilityError,
  runConformanceWorkflow
};
