import { Effect } from "effect";
import type { Document } from "./document";
import { RagService } from "./RagService";

export function ingest(documents: Document[]) {
  return Effect.flatMap(RagService, (svc) => svc.ingest(documents));
}
