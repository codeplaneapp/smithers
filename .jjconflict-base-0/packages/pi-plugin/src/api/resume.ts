import { SmithersPiHttpClient } from "./SmithersPiHttpClient.js";

type ResumeArgs = {
  workflowPath: string;
  runId: string;
  baseUrl?: string;
  apiKey?: string;
};

export async function resume(args: ResumeArgs) {
  return new SmithersPiHttpClient(args).json("/v1/runs", {
    method: "POST",
    body: {
      workflowPath: args.workflowPath,
      runId: args.runId,
      resume: true,
    },
  });
}
