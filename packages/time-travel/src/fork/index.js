import { Cause, Effect, Exit } from "effect";
import { forkRun as forkRunEffect } from "./forkRunEffect.js";
import { getBranchInfo as getBranchInfoEffect } from "./getBranchInfoEffect.js";
import { listBranches as listBranchesEffect } from "./listBranchesEffect.js";
export { forkRunEffect, getBranchInfoEffect, listBranchesEffect };

/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("../BranchInfo.ts").BranchInfo} BranchInfo */
/** @typedef {import("../EffectBoundaryReport.ts").EffectBoundaryReport} EffectBoundaryReport */
/** @typedef {import("../ForkParams.ts").ForkParams} ForkParams */
/** @typedef {import("../snapshot/Snapshot.ts").Snapshot} Snapshot */

/**
 * Fork a run at the given frame, returning the child run metadata.
 *
 * @param {SmithersDb} adapter
 * @param {ForkParams} params
 * @returns {Promise<{ runId: string; branch: BranchInfo; snapshot: Snapshot; effectBoundary: EffectBoundaryReport }>}
 */
export async function forkRun(adapter, params) {
  const exit = await Effect.runPromiseExit(forkRunEffect(adapter, params));
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
/**
 * List branches that were forked from the given parent run.
 *
 * @param {SmithersDb} adapter
 * @param {string} parentRunId
 * @returns {Promise<BranchInfo[]>}
 */
export function listBranches(adapter, parentRunId) {
  return Effect.runPromise(listBranchesEffect(adapter, parentRunId));
}
/**
 * Get the branch record for a run, if any.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<BranchInfo | undefined>}
 */
export function getBranchInfo(adapter, runId) {
  return Effect.runPromise(getBranchInfoEffect(adapter, runId));
}
