import { RuntimeCapabilityError, RUNTIME_CAPABILITY_UNAVAILABLE } from "@smithers-orchestrator/driver/RuntimeCapabilityError";

export type RuntimeConformanceResult = {
  result: { runId: string; status: string; output?: unknown };
  stored: { status?: string } | undefined;
  outputs: Record<string, unknown[]> | undefined;
  generateCalls: number;
  schemaEnforced: boolean;
  capabilityProof: Record<string, { runtime: string; capability: string; operation: string }>;
  host: Record<string, unknown>;
};

export type RuntimeConformanceLane = "Browser" | "Cloudflare Workers" | "Vercel" | "Node.js" | "Bun";

function fail(message: string): never {
  throw new Error(`runtime conformance: ${message}`);
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

/** Assert the portable production workflow contract for every supported host. */
export function assertRuntimeConformance(
  proof: RuntimeConformanceResult,
  lane: RuntimeConformanceLane,
): RuntimeConformanceResult {
  expect(proof.result?.status === "finished", `run did not finish (${proof.result?.status ?? "missing result"})`);
  expect(proof.stored?.status === "finished", "terminal run state was not persisted");
  expect(proof.result.output && (proof.result.output as { answer?: unknown }).answer === 43, "dependent output was not propagated");
  expect(proof.generateCalls === 1, `agent was called ${proof.generateCalls} times`);
  expect(proof.schemaEnforced === true, "agent output schema was not enforced");
  expect(proof.outputs?.agent_output?.[0] && (proof.outputs.agent_output[0] as { answer?: unknown }).answer === 42, "agent output was not persisted");
  expect(proof.outputs?.dependent_output?.[0] && (proof.outputs.dependent_output[0] as { answer?: unknown }).answer === 43, "dependent output was not persisted");
  expect(/^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(proof.result.runId), "run id is not UUID-shaped");

  for (const capability of ["filesystem", "subprocess", "sandbox", "worktree"]) {
    const details = proof.capabilityProof[capability];
    expect(details?.runtime === "browser", `missing typed unsupported capability error for ${capability}`);
    expect(details.capability === capability, `wrong capability in ${capability} error`);
    expect(details.operation.length > 0, `missing operation in ${capability} error`);
  }

  const requiredHostChecks: Record<RuntimeConformanceLane, string[]> = {
    Browser: [],
    "Cloudflare Workers": ["fetchLifecycle", "binding"],
    Vercel: ["fetchLifecycle", "vercelRuntime"],
    "Node.js": ["filesystem", "subprocess"],
    Bun: ["filesystem", "subprocess"],
  };
  for (const check of requiredHostChecks[lane]) expect(proof.host[check] === true, `host check ${check} did not pass`);
  return proof;
}

export function isRuntimeCapabilityError(error: unknown, capability: string, operation: string): boolean {
  return error instanceof RuntimeCapabilityError && error.code === RUNTIME_CAPABILITY_UNAVAILABLE && error.capability === capability && error.operation === operation;
}
