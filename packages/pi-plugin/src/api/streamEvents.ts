import { SmithersPiHttpClient } from "./SmithersPiHttpClient.js";

type StreamEventsArgs = {
  runId: string;
  baseUrl?: string;
  apiKey?: string;
};

export async function* streamEvents(args: StreamEventsArgs) {
  yield* new SmithersPiHttpClient(args).events(`/v1/runs/${args.runId}/events`);
}
