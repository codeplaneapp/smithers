import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import { fromPromise } from "@smithers/driver/interop";
import type { SmithersError } from "@smithers/errors/SmithersError";
import { smithersSnapshots } from "../schema";
import type { Snapshot } from "./Snapshot";

export function listSnapshots(
  adapter: SmithersDb,
  runId: string,
): Effect.Effect<Array<Pick<Snapshot, "runId" | "frameNo" | "contentHash" | "createdAtMs" | "vcsPointer">>, SmithersError> {
  return fromPromise(
    "list snapshots",
    (): Promise<Array<Pick<Snapshot, "runId" | "frameNo" | "contentHash" | "createdAtMs" | "vcsPointer">>> =>
    (adapter as any).db
      .select({
        runId: smithersSnapshots.runId,
        frameNo: smithersSnapshots.frameNo,
        contentHash: smithersSnapshots.contentHash,
        createdAtMs: smithersSnapshots.createdAtMs,
        vcsPointer: smithersSnapshots.vcsPointer,
      })
      .from(smithersSnapshots)
      .where(eq(smithersSnapshots.runId, runId))
      .orderBy(smithersSnapshots.frameNo),
    {
      code: "DB_QUERY_FAILED",
      details: { runId },
    },
  ).pipe(
    Effect.annotateLogs({ runId }),
    Effect.withLogSpan("time-travel:list-snapshots"),
  );
}

