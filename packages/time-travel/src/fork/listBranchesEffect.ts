import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { BranchInfo } from "../BranchInfo";
export declare function listBranches(adapter: SmithersDb, parentRunId: string): Effect.Effect<BranchInfo[], SmithersError>;
