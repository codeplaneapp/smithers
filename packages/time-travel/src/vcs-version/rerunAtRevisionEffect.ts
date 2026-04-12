import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersError } from "@smithers/errors/SmithersError";
export declare function rerunAtRevision(adapter: SmithersDb, runId: string, frameNo: number, opts?: {
    cwd?: string;
}): Effect.Effect<{
    restored: boolean;
    vcsPointer: string | null;
    error?: string;
}, SmithersError, CommandExecutor>;
