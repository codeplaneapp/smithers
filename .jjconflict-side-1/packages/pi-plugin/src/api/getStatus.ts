import { SmithersPiHttpClient } from "./SmithersPiHttpClient.js";

type GetStatusArgs = {
  runId: string;
  baseUrl?: string;
  apiKey?: string;
};

export async function getStatus(args: GetStatusArgs) {
  return new SmithersPiHttpClient(args).json(`/v1/runs/${args.runId}`);
}
