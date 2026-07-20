import { SmithersPiHttpClient } from "./SmithersPiHttpClient.js";

type RunWorkflowArgs = {
  workflowPath: string;
  input: unknown;
  runId?: string;
  baseUrl?: string;
  apiKey?: string;
};

export async function runWorkflow(args: RunWorkflowArgs) {
  return new SmithersPiHttpClient(args).json("/v1/runs", {
    method: "POST",
    body: {
      workflowPath: args.workflowPath,
      input: args.input,
      runId: args.runId,
    },
  });
}
