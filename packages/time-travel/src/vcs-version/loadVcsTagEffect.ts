import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { VcsTag } from "./VcsTag";
export declare function loadVcsTag(adapter: SmithersDb, runId: string, frameNo: number): Effect.Effect<VcsTag | undefined, SmithersError>;
