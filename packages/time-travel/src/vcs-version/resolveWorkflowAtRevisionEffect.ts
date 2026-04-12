import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import { SmithersError } from "@smithers/errors/SmithersError";
/**
 * Create a jj workspace at the revision recorded for a specific snapshot.
 * Returns the workspace path or null if no VCS tag exists.
 */
export declare function resolveWorkflowAtRevision(adapter: SmithersDb, runId: string, frameNo: number, workspacePath: string): Effect.Effect<{
    workspacePath: string;
    vcsPointer: string;
} | null, SmithersError, CommandExecutor>;
