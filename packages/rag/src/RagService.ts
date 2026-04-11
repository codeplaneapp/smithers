import { Context, Effect } from "effect";
import type { SmithersError } from "@smithers/core/errors";
import type { Document } from "./document";
import type { RetrievalResult } from "./RetrievalResult";

// ---------------------------------------------------------------------------
// RagService — Effect Context.Tag
// ---------------------------------------------------------------------------

export class RagService extends Context.Tag("RagService")<
  RagService,
  {
    readonly ingest: (
      documents: Document[],
    ) => Effect.Effect<void, SmithersError>;
    readonly retrieve: (
      query: string,
      topK?: number,
    ) => Effect.Effect<RetrievalResult[], SmithersError>;
  }
>() {}
