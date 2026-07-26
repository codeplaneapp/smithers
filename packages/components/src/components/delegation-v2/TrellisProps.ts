import type { AgentLike } from "@smithers-orchestrator/agents/AgentLike";
import type { OutputTarget } from "../OutputTarget.ts";
import type {
  AcceptanceCriterion,
  CriticalExecutionCategory,
  DelegationV2Role,
  DelegationV2WorkKind,
  GoalContract,
} from "./delegationV2Schemas.ts";

export type TrellisAgents = Record<DelegationV2Role, AgentLike | AgentLike[]>;

export type TrellisOutputs = {
  dv2Author: OutputTarget;
  dv2Worker: OutputTarget;
  dv2Validation: OutputTarget;
  dv2Outcome: OutputTarget;
  dv2Final: OutputTarget;
  dv2Question: OutputTarget;
  dv2Answer: OutputTarget;
};

export type TrellisLimits = {
  /** Hard global cap partitioned across every Sol/Fable turn and semantic repair in the recursive tree. */
  maxTotalAuthorTurns?: number;
  /** Maximum author continuations for one logical invocation, including generation zero. */
  maxAuthorGenerations?: number;
  /** Maximum recursively nested Sol/Fable author invocations. */
  maxAuthorDepth?: number;
  /** Maximum nodes accepted in one authored fragment. */
  maxNodesPerProgram?: number;
  /** Maximum expression depth inside one authored fragment. */
  maxProgramDepth?: number;
  /** Maximum branches in one parallel expression. Sequences remain bounded by maxNodesPerProgram. */
  maxFanout?: number;
  /** Maximum bytes in one authored prompt field. */
  maxPromptBytes?: number;
  /** Maximum aggregate authored prompt bytes in one fragment. */
  maxTotalPromptBytes?: number;
};

export type TrellisCriticalExecutionCategory = CriticalExecutionCategory;

/**
 * Trusted caller-owned ceiling for exceptional Sol/Fable implementation.
 * Omitting it disables direct high-tier execution. Authored requests must fit
 * every category, workspace-relative path, and changed-line bound below.
 */
export type TrellisCriticalExecutionPolicy = {
  allowedCategories: TrellisCriticalExecutionCategory[];
  allowedPathPrefixes: string[];
  maxChangedLines: number;
};

export type TrellisProps = {
  /** Human goal. A root GoalContract is derived from this when goal is omitted. */
  prompt: string;
  /** Optional explicit root goal contract. */
  goal?: GoalContract;
  /** Root proof obligations exposed to every author continuation. */
  acceptance?: AcceptanceCriterion[];
  /** Extra trusted caller instructions; never interpreted as graph authority. */
  instructions?: string;
  /** Root author role. Terra and Luna are intentionally rejected here. */
  role?: Extract<DelegationV2Role, "sol" | "fable">;
  /** Root work playbook. */
  work?: DelegationV2WorkKind;
  /** Nominal contract returned by the root invocation. Default: work_product. */
  outputContract?: import("./delegationV2Schemas.ts").OutputContractId;
  /** Role-bound agents or failover chains. */
  agents: TrellisAgents;
  /** Output targets registered from delegationV2Schemas. */
  outputs: TrellisOutputs;
  /** Gateway-safe namespace for every physical node id. Default: trellis. */
  idPrefix?: string;
  /** Caller-owned revision for provider/tool policy changes not otherwise visible in agent metadata. */
  semanticRevision?: string;
  /** Caller-owned exceptional implementation ceiling. Omit to force all executable work below Sol/Fable. */
  criticalExecutionPolicy?: TrellisCriticalExecutionPolicy;
  /** Local and compiler cap for every Parallel. The run must pin the same cap. */
  maxConcurrency?: number;
  limits?: TrellisLimits;
  skipIf?: boolean;
};
