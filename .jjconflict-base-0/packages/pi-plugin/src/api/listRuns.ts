import { SmithersPiHttpClient } from "./SmithersPiHttpClient.js";

type ListRunsArgs = {
  limit?: number;
  status?: string;
  baseUrl?: string;
  apiKey?: string;
};

export async function listRuns(args: ListRunsArgs = {}) {
  const params = new URLSearchParams();
  if (args.limit !== undefined) {
    params.set("limit", String(args.limit));
  }
  if (args.status) {
    params.set("status", args.status);
  }
  const query = params.toString();
  return new SmithersPiHttpClient(args).json(`/v1/runs${query ? `?${query}` : ""}`);
}
