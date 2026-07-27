import { runSteps, type NodeStatus, type Run, type RunNode } from "./Run.ts";

/**
 * Pure completion estimator over the run node tree. Derives progress purely
 * from leaf statuses — no timers, no fabricated numbers. Surfacing (progress
 * bars, ETA copy) lives in sibling modules; this module is the single source
 * of truth they read from. Ported verbatim from multi's `src/runs/runProgress.ts`.
 */
export type RunProgress = {
  /** Leaves that have reached a terminal status (ok or failed). */
  completed: number;
  /** Total leaf count under the root. */
  total: number;
  /** completed/total in 0..1, or null when the tree has no leaves — never a fake number. */
  ratio: number | null;
  /** Display name of the first non-completed leaf (the current step), else null. */
  phase: string | null;
};

/** Terminal leaf statuses: the work is done, whether it succeeded or not. */
const COMPLETED_STATUSES: ReadonlySet<NodeStatus> = new Set(["ok", "failed"]);

/** Depth-first leaf collection; internal (parent) nodes are not counted. */
function collectLeaves(node: RunNode, out: RunNode[]): void {
  const children = node.children ?? [];
  if (children.length === 0) {
    out.push(node);
    return;
  }
  for (const child of children) {
    collectLeaves(child, out);
  }
}

/**
 * Estimate run completion from the node graph. Leaves are the unit of work:
 * a leaf is complete when its status is terminal (`ok` | `failed`); `running`,
 * `queued`, and `waiting` leaves are remaining. A run whose root has no
 * children has no work to measure — ratio is null, never 0 or 1.
 */
export function runProgress(run: Run): RunProgress {
  const leaves: RunNode[] = [];
  for (const step of runSteps(run)) {
    collectLeaves(step, leaves);
  }

  let completed = 0;
  let phase: string | null = null;
  for (const leaf of leaves) {
    if (COMPLETED_STATUSES.has(leaf.status)) {
      completed += 1;
    } else if (phase === null) {
      phase = leaf.cardLabel ?? leaf.name;
    }
  }

  const total = leaves.length;
  return {
    completed,
    total,
    ratio: total === 0 ? null : completed / total,
    phase,
  };
}
