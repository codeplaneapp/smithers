import { SmithersPiHttpClient } from "./SmithersPiHttpClient.js";

type DenyArgs = {
  runId: string;
  nodeId: string;
  iteration?: number;
  note?: string;
  baseUrl?: string;
  apiKey?: string;
};

export async function deny(args: DenyArgs) {
  return new SmithersPiHttpClient(args).json(
    `/v1/runs/${args.runId}/nodes/${args.nodeId}/deny`,
    {
      method: "POST",
      body: {
        iteration: args.iteration ?? 0,
        note: args.note,
      },
    },
  );
}
