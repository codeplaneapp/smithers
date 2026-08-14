import { Effect } from 'effect';
import { SmithersError } from '@smthrs/errors/SmithersError';

/**
 * Durable persistence seam for polling-source cursors. The db-backed
 * implementation (`makeDbCursorStore`) rides `_smithers_integration_cursors`.
 */
type CursorStore = {
    get: (sourceId: string) => Effect.Effect<string | null | undefined, SmithersError>;
    set: (sourceId: string, cursor: string | null) => Effect.Effect<void, SmithersError>;
};

export type { CursorStore };
