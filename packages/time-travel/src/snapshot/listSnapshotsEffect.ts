import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { Snapshot } from "./Snapshot";
export declare function listSnapshots(adapter: SmithersDb, runId: string): Effect.Effect<Array<Pick<Snapshot, "runId" | "frameNo" | "contentHash" | "createdAtMs" | "vcsPointer">>, SmithersError>;
