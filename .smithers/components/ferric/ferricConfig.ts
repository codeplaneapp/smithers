import { realpathSync } from "node:fs";
import { join } from "node:path";

/** Captured at module load, before anything can chdir. */
export const LAUNCH_ROOT = process.cwd();

export const MILESTONES = ["M0", "M1", "M2", "M25", "M3", "M4", "M5M6", "M7", "M8", "GA", "M9", "DONE"] as const;
export type Milestone = (typeof MILESTONES)[number];

export const NEXT: Partial<Record<Milestone, Milestone>> = {
  // M25 ("M2.5") is the end-to-end vertical: one component travels
  // element → fiber → render → commit → DOM through Rust before the boundary
  // spike and long before the 59-module cycle. Integration reality surfaces
  // here, cheaply, instead of inside the largest milestone.
  M0: "M1",
  M1: "M2",
  M2: "M25",
  M25: "M3",
  M3: "M4",
  M4: "M5M6",
  M5M6: "M7",
  M7: "M8",
  M8: "GA",
  GA: "M9",
  M9: "DONE",
};

/** Budget envelopes (spec §7) plus the round-3 graduation thresholds. */
export const MODEL_CAP_CENTS = 250_000_00;
export const PRE_M8_STOP_CENTS = 200_000_00;
export const MILESTONE_TOKEN_BUDGET = 60_000_000;

/** One work item: a leaf module, an SCC cohort, or a whole-phase unit. */
export type SliceDef = {
  id: string;
  kind: "leaf" | "cohort" | "phase";
  modules: string[];
  gate: string;
};

export type FerricConfig = {
  milestone: Milestone;
  repo: string;
  reactRepo: string;
  queuePath: string;
  maxLanes: number;
  spentCents: number;
  lineage: string[];
};

/**
 * Resolve run configuration from input and the ContinueAsNew continuation.
 *
 * An unknown milestone throws rather than falling through to a terminal phase:
 * an audited implementation routed typos to `DONE` and "completed" the campaign
 * on a misspelling.
 */
export function cfg(ctx: any): FerricConfig {
  const cont = (ctx.input as any)?.__smithersContinuation?.payload ?? {};
  // The CONTINUATION wins over the launch input. Run input is immutable and is
  // carried into every successor run, so reading it first pins the campaign to
  // the milestone it was launched at: M0 hands off to M1, the successor reads
  // input.milestone === "M0" again, and the campaign loops M0 forever.
  const rawMilestone = cont.milestone ?? ctx.input?.milestone ?? "M0";
  if (!MILESTONES.includes(rawMilestone)) {
    throw new Error(`Unknown milestone "${rawMilestone}". Valid: ${MILESTONES.join(", ")}`);
  }
  return {
    milestone: rawMilestone as Milestone,
    repo: ctx.input?.campaignRepoPath ?? LAUNCH_ROOT,
    reactRepo: ctx.input?.reactRepoPath ?? "/Users/williamcory/react",
    queuePath:
      ctx.input?.moduleQueuePath ?? "/Users/williamcory/smithers/.smithers/specs/react-rust-port/MODULE_QUEUE.tsv",
    maxLanes: Math.min(6, Math.max(4, ctx.input?.maxLanes ?? 4)),
    spentCents: Math.max(ctx.input?.modelSpentCents ?? 0, cont.spentCents ?? 0),
    lineage: (cont.lineage ?? []) as string[],
  };
}

/**
 * Worktree root, resolved through symlinks. On macOS `/tmp` is a symlink to
 * `/private/tmp`, and a jj workspace created under the symlinked path fails the
 * engine's worktree root check with WORKTREE_CREATE_FAILED.
 */
export const LANE_ROOT = (() => {
  try {
    return join(realpathSync("/tmp"), "ferric-lanes");
  } catch {
    return "/tmp/ferric-lanes";
  }
})();
