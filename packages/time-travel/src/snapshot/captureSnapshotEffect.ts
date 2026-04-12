import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { Snapshot } from "./Snapshot";
import type { SnapshotData } from "./SnapshotData";
export declare function captureSnapshot(adapter: SmithersDb, runId: string, frameNo: number, data: SnapshotData): Effect.Effect<Snapshot, SmithersError>;
