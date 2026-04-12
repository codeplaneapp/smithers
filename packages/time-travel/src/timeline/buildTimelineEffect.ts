import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { RunTimeline } from "../RunTimeline";
export declare function buildTimeline(adapter: SmithersDb, runId: string): Effect.Effect<RunTimeline, SmithersError>;
