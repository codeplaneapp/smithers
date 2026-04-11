import { Effect } from "effect";
import { RagService } from "./RagService";

export function retrieve(query: string, topK?: number) {
  return Effect.flatMap(RagService, (svc) => svc.retrieve(query, topK));
}
