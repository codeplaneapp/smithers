import { SmithersPiHttpClient } from "./SmithersPiHttpClient.js";

type ApproveArgs = {
  runId: string;
  nodeId: string;
  iteration?: number;
  note?: string;
  baseUrl?: string;
  apiKey?: string;
};

export async function approve(args: ApproveArgs) {
  return new SmithersPiHttpClient(args).json(
    `/v1/runs/${args.runId}/nodes/${args.nodeId}/approve`,
    {
      method: "POST",
      body: {
        iteration: args.iteration ?? 0,
        note: args.note,
      },
    },
  );
}
