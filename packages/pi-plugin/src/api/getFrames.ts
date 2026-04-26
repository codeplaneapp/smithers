import { SmithersPiHttpClient } from "./SmithersPiHttpClient.js";

type GetFramesArgs = {
  runId: string;
  tail?: number;
  baseUrl?: string;
  apiKey?: string;
};

export async function getFrames(args: GetFramesArgs) {
  return new SmithersPiHttpClient(args).json(
    `/v1/runs/${args.runId}/frames?limit=${args.tail ?? 20}`,
  );
}
