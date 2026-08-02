import type { AgentLike } from "@smthrs/agents/AgentLike";
import type { ScorersMap } from "@smthrs/graph/types";
import type { OutputTarget } from "../OutputTarget.ts";
import type { Tier } from "./delegationSchemas.ts";

/** One agent (or failover chain) per intelligence tier. Tiers are labels only. */
export type DelegationAgents = Partial<Record<Tier, AgentLike | AgentLike[]>>;

/**
 * Output targets for the delegation tables — pass the matching subset of
 * `createSmithers({ ...delegationSchemas }).outputs`. `dcApproval` is only
 * needed with an `approvalPolicy`, `dcBudget` only with a `budget`, and
 * `dcScore` only with run-level `scorers`.
 */
export type DelegationOutputs = {
  dcGoal: OutputTarget;
  dcQuestion: OutputTarget;
  dcForecast: OutputTarget;
  dcGoalApproval: OutputTarget;
  dcPlan: OutputTarget;
  dcPreview: OutputTarget;
  dcDevPreview?: OutputTarget;
  dcGates: OutputTarget;
  dcProbe: OutputTarget;
  dcReplan: OutputTarget;
  dcExec: OutputTarget;
  dcReview: OutputTarget;
  dcApproval?: OutputTarget;
  dcEdit: OutputTarget;
  dcSkip: OutputTarget;
  dcPoll: OutputTarget;
  dcBudget?: OutputTarget;
  dcScore?: OutputTarget;
};

/** Run budget. Exceeding a hard limit raises an error into the run; >= 80% emits a warning row. */
export type DelegationBudget = {
  maxUsd?: number;
  maxMinutes?: number;
};

/** Caller-provided scorers wired onto exec tasks, review tasks, and the run-level scoring task. */
export type DelegationScorers = {
  exec?: ScorersMap;
  review?: ScorersMap;
  run?: ScorersMap;
};

/** Props shared by every delegation phase composite. */
export type DelegationSharedProps = {
  /**
   * Physical node-id prefix (`<idPrefix>:<logicalId>:<phase>`). Default "dc".
   *
   * WARNING: the delegation fold and the `smithers ui` delegation UI
   * (`foldDelegation`/`delegationTableForNodeId` in
   * `@smthrs/gateway-react`) only recognize the default
   * `"dc"` prefix. A custom prefix still executes correctly, but the run
   * renders NO delegation UI until the fold learns the new prefix — keep the
   * default unless you also extend the fold.
   */
  idPrefix?: string;
  /** Agent per tier. Missing tiers fall back to the nearest configured tier. */
  agents: DelegationAgents;
  /** Output targets for the delegation tables (register `delegationSchemas` in createSmithers). */
  outputs: DelegationOutputs;
  /** When set, delegating agents may declare approval gates where this policy applies (and pass a clarified policy to children). Absent = fully automatic. */
  approvalPolicy?: string;
  /** Tier ladder, strongest first. Default ["fable", "opus", "sonnet", "haiku"]. */
  tierOrder?: Tier[];
  /** Max decomposition depth (default 3). */
  maxDepth?: number;
  /** Max parallel tasks per fan-out phase (default 4). */
  maxConcurrency?: number;
  /** Max replan rounds per node (default 3). */
  maxDeriskRounds?: number;
  /** Render the end-of-run satisfaction poll (default true). */
  poll?: boolean;
  /** Run budget, enforced from rolled-up dcExec actuals (and wall-clock via Aspects for maxMinutes). */
  budget?: DelegationBudget;
  /** Delegation scorers (e.g. from `smthrs/scorers`). */
  scorers?: DelegationScorers;
  skipIf?: boolean;
};
