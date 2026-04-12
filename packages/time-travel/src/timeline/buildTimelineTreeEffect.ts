import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { TimelineTree } from "../TimelineTree";
export declare function buildTimelineTree(adapter: SmithersDb, runId: string): Effect.Effect<TimelineTree, SmithersError>;
