import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { VcsTag } from "./VcsTag";
export declare function tagSnapshotVcs(adapter: SmithersDb, runId: string, frameNo: number, opts?: {
    cwd?: string;
}): Effect.Effect<VcsTag | null, SmithersError, CommandExecutor>;
