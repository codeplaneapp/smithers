// @smithers-type-exports-begin
/** @typedef {import("./ReplayResult.ts").ReplayResult} ReplayResult */
// @smithers-type-exports-end

import { Cause, Effect, Exit } from "effect";
import * as BunContext from "@effect/platform-bun/BunServices";
import { replayFromCheckpoint as replayFromCheckpointEffect } from "./replayFromCheckpointEffect.js";
export { replayFromCheckpointEffect };

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./ReplayParams.ts").ReplayParams} ReplayParams */

/**
 * Fork a run from a checkpoint and optionally restore the VCS working copy.
 *
 * @param {SmithersDb} adapter
 * @param {ReplayParams} params
 * @returns {Promise<ReplayResult>}
 */
export async function replayFromCheckpoint(adapter, params) {
  const exit = await Effect.runPromiseExit(
    replayFromCheckpointEffect(adapter, params).pipe(Effect.provide(BunContext.layer)),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
