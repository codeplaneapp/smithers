// src/runtimeConformance.ts
import { RuntimeCapabilityError, RUNTIME_CAPABILITY_UNAVAILABLE } from "@smithers-orchestrator/driver/RuntimeCapabilityError";
function fail(message) {
  throw new Error(`runtime conformance: ${message}`);
}
function expect(condition, message) {
  if (!condition) fail(message);
}
function assertRuntimeConformance(proof, lane) {
  expect(proof.result?.status === "finished", `run did not finish (${proof.result?.status ?? "missing result"})`);
  expect(proof.stored?.status === "finished", "terminal run state was not persisted");
  expect(proof.result.output && proof.result.output.answer === 43, "dependent output was not propagated");
  expect(proof.generateCalls === 1, `agent was called ${proof.generateCalls} times`);
  expect(proof.schemaEnforced === true, "agent output schema was not enforced");
  expect(proof.outputs?.agent_output?.[0] && proof.outputs.agent_output[0].answer === 42, "agent output was not persisted");
  expect(proof.outputs?.dependent_output?.[0] && proof.outputs.dependent_output[0].answer === 43, "dependent output was not persisted");
  expect(/^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(proof.result.runId), "run id is not UUID-shaped");
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
export {
  assertRuntimeConformance,
  isRuntimeCapabilityError
};
