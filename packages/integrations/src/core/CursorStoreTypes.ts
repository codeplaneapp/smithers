import type { Effect } from "effect";
import type { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

/**
 * Durable persistence seam for polling-source cursors. The db-backed
 * implementation (`makeDbCursorStore`) rides `_smithers_integration_cursors`.
 */
export type CursorStore = {
  get: (sourceId: string) => Effect.Effect<string | null | undefined, SmithersError>;
  set: (sourceId: string, cursor: string | null) => Effect.Effect<void, SmithersError>;
};
