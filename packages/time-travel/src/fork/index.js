import { Effect } from "effect";
import { forkRun as forkRunEffect } from "./forkRunEffect.js";
import { getBranchInfo as getBranchInfoEffect } from "./getBranchInfoEffect.js";
import { listBranches as listBranchesEffect } from "./listBranchesEffect.js";
export { forkRunEffect, getBranchInfoEffect, listBranchesEffect, };
/**
 * @param {Parameters<typeof forkRunEffect>} ...args
 */
export function forkRun(...args) {
    return Effect.runPromise(forkRunEffect(...args));
}
/**
 * @param {Parameters<typeof listBranchesEffect>} ...args
 */
export function listBranches(...args) {
    return Effect.runPromise(listBranchesEffect(...args));
}
/**
 * @param {Parameters<typeof getBranchInfoEffect>} ...args
 */
export function getBranchInfo(...args) {
    return Effect.runPromise(getBranchInfoEffect(...args));
}
