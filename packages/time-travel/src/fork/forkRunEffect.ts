import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import { SmithersError } from "@smithers/errors/SmithersError";
import type { ForkParams } from "../ForkParams";
import type { BranchInfo } from "../BranchInfo";
import type { Snapshot } from "../snapshot/Snapshot";
export declare function forkRun(adapter: SmithersDb, params: ForkParams): Effect.Effect<{
    runId: string;
    branch: BranchInfo;
    snapshot: Snapshot;
}, SmithersError>;
