import type { CommandExecutor } from "@effect/platform/CommandExecutor";
import { Effect } from "effect";
import type { SmithersDb } from "@smithers/db/adapter";
import type { SmithersError } from "@smithers/errors/SmithersError";
import type { ReplayParams } from "./ReplayParams";
import type { ReplayResult } from "./ReplayResult";
/**
 * Fork a run from a checkpoint, optionally restore the VCS working copy
 * to the revision that was active at the source frame, then return the
 * new run metadata so the caller can resume execution.
 */
export declare function replayFromCheckpoint(adapter: SmithersDb, params: ReplayParams): Effect.Effect<ReplayResult, SmithersError, CommandExecutor>;
