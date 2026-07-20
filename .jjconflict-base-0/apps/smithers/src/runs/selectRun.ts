import { AUTH_REFACTOR_FRAMES } from "./authRefactorFrames";
import type { NodeStatus, Run } from "./Run";
import type { RunState } from "./runsStore";

const LAST_FRAME = AUTH_REFACTOR_FRAMES.length - 1;

/**
 * Derive the display `Run` (current frame, root node, resolved status) from raw
 * run state. Pure, so callers subscribe to `runs` and compute in the render body
 * rather than returning a fresh object from a store selector.
 */
export function selectRun(runs: RunState[], id: string): Run | undefined {
  const run = runs.find((entry) => entry.id === id);
  if (!run) {
    return undefined;
  }
  const frame = Math.min(run.frame, LAST_FRAME);
  const root = AUTH_REFACTOR_FRAMES[frame];
  let status: NodeStatus = root.status;
  if (run.canceled || run.gate === "denied") {
    status = "failed";
  }
  return {
    id: run.id,
    title: run.title,
    model: run.model,
    runId: run.runId,
    status,
    startedAtMs: run.startedAtMs,
    frame,
    frameCount: AUTH_REFACTOR_FRAMES.length,
    root,
  };
}
