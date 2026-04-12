import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { Snapshot } from "./Snapshot";
export declare function loadSnapshot(adapter: SmithersDb, runId: string, frameNo: number): Effect.Effect<Snapshot | undefined, SmithersError>;
export declare function loadLatestSnapshot(adapter: SmithersDb, runId: string): Effect.Effect<Snapshot | undefined, SmithersError>;
