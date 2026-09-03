import { mock } from "bun:test";
import type { WorkflowCoverageOptions } from "smthrs/testing";
import { coverWorkflow } from "smthrs/testing";

const ai = await import("ai");
process.env.SMITHERS_EXAMPLE_DB_PATH = ":memory:";

class InertToolLoopAgent {
  readonly id = "example-test-agent";
  readonly tools = {};

  constructor(_options: unknown) {}

  async generate(): Promise<never> {
    throw new Error("Example coverage must not call a real AI SDK agent");
  }
}

mock.module("ai", () => ({ ...ai, ToolLoopAgent: InertToolLoopAgent }));
mock.module("@ai-sdk/anthropic", () => ({ anthropic: () => ({ provider: "inert" }) }));

export async function coverExample(path: string, options?: WorkflowCoverageOptions) {
  const workflowModule = await import(path);
  return coverWorkflow(workflowModule, options);
}
