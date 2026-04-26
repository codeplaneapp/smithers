import { SmithersPiHttpClient } from "./SmithersPiHttpClient.js";

type CancelArgs = {
  runId: string;
  baseUrl?: string;
  apiKey?: string;
};

export async function cancel(args: CancelArgs) {
  return new SmithersPiHttpClient(args).json(`/v1/runs/${args.runId}/cancel`, {
    method: "POST",
    body: {},
  });
}
