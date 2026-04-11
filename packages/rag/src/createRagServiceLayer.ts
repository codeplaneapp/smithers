import { Layer } from "effect";
import type { Document } from "./document";
import type { RagPipelineConfig } from "./RagPipelineConfig";
import { RagService } from "./RagService";
import { ingestEffect } from "./ingestEffect";
import { retrieveEffect } from "./retrieveEffect";

export function createRagServiceLayer(config: RagPipelineConfig) {
  return Layer.succeed(RagService, {
    ingest: (documents: Document[]) => ingestEffect(config, documents),
    retrieve: (query: string, topK?: number) =>
      retrieveEffect(config, query, topK),
  });
}
