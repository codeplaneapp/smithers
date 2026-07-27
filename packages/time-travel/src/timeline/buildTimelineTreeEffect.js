import { Effect } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { buildTimeline } from "./buildTimelineEffect.js";
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("../TimelineTree.ts").TimelineTree} TimelineTree */

const TIMELINE_TREE_MAX_DEPTH = 100;

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Effect.Effect<TimelineTree, SmithersError>}
 */
export function buildTimelineTree(adapter, runId) {
  return buildTimelineTreeInternal(adapter, runId, []);
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string[]} path
 * @returns {Effect.Effect<TimelineTree, SmithersError>}
 */
function buildTimelineTreeInternal(adapter, runId, path) {
  return Effect.gen(function* () {
    const existingIndex = path.indexOf(runId);
    if (existingIndex !== -1) {
      const cyclePath = [...path.slice(existingIndex), runId];
      return yield* Effect.fail(
        new SmithersError("INVALID_INPUT", `Timeline tree contains a fork ancestry cycle: ${cyclePath.join(" -> ")}`, {
          runId,
          cyclePath,
        }),
      );
    }
    if (path.length > TIMELINE_TREE_MAX_DEPTH) {
      return yield* Effect.fail(
        new SmithersError("INVALID_INPUT", `Timeline tree exceeds maximum depth of ${TIMELINE_TREE_MAX_DEPTH}.`, {
          runId,
          depth: path.length,
          maxDepth: TIMELINE_TREE_MAX_DEPTH,
        }),
      );
    }
    const timeline = yield* buildTimeline(adapter, runId);
    // Include both branches and child workflows, while keeping those two
    // relationships distinct in persistence.
    const childRunIds = new Set();
    for (const frame of timeline.frames) {
      for (const fork of frame.forkPoints) {
        childRunIds.add(fork.runId);
      }
    }
    if (typeof adapter.listRunDescendants === "function") {
      const descendants = yield* adapter.listRunDescendants(runId);
      for (const child of descendants) {
        if (child.depth === 1) childRunIds.add(child.runId);
      }
    }
    // Recursively build subtrees
    const children = [];
    const childPath = [...path, runId];
    for (const childId of childRunIds) {
      const childTree = yield* buildTimelineTreeInternal(adapter, childId, childPath);
      children.push(childTree);
    }
    return { timeline, children };
  }).pipe(Effect.annotateLogs({ runId }), Effect.withLogSpan("time-travel:build-timeline-tree"));
}
