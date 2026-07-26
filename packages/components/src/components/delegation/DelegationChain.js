// @smithers-type-exports-begin
/** @typedef {import("./DelegationChainProps.ts").DelegationChainProps} DelegationChainProps */
// @smithers-type-exports-end

import React from "react";
import { Sequence } from "../Sequence.js";
import { Parallel } from "../Parallel.js";
import { Aspects } from "../Aspects.js";
import { GoalRefinement } from "./GoalRefinement.js";
import { DelegationPlanning } from "./DelegationPlanning.js";
import { DelegationPreview } from "./DelegationPreview.js";
import { BackpressurePlanning } from "./BackpressurePlanning.js";
import { DeriskLoop } from "./DeriskLoop.js";
import { DelegationExecution } from "./DelegationExecution.js";
import { DelegationScoring } from "./DelegationScoring.js";
import { DelegationEditListener } from "./DelegationEditListener.js";

/**
 * <DelegationChain> — the full delegation-chain workflow composite.
 *
 * A `<Sequence>` of the seven phases (goal refinement → recursive planning →
 * zero-backpressure previews → backpressure planning → derisk probes/replans
 * → gated execution → scoring + poll) in `<Parallel>` with the live
 * `dc-edit` signal listener. Every phase is reactive: it derives its slice of
 * the tree from the dc* output rows each render, so fan-out materializes
 * level by level as rows land, and user edits/probe findings replan the
 * affected subtree without restarting anything.
 *
 * When `budget.maxMinutes` is set the whole chain is wrapped in `<Aspects>`
 * with a wall-clock `latencySlo` (engine-enforced at task dispatch); dollar
 * budgets are enforced by per-leaf guard tasks comparing rolled-up dcExec
 * actuals (hard error over the limit, warning row at >= 80%).
 *
 * Register `delegationSchemas` in `createSmithers` and pass the matching
 * `outputs` subset:
 *
 * ```tsx
 * const { smithers, outputs } = createSmithers({ ...delegationSchemas });
 * <DelegationChain
 *   prompt={ctx.input.prompt}
 *   agents={{ fable, opus, sonnet, haiku }}
 *   outputs={outputs}
 * />
 * ```
 * @param {DelegationChainProps} props
 */
export function DelegationChain(props) {
  if (props.skipIf) return null;
  const shared = {
    idPrefix: props.idPrefix,
    agents: props.agents,
    outputs: props.outputs,
    approvalPolicy: props.approvalPolicy,
    tierOrder: props.tierOrder,
    maxDepth: props.maxDepth,
    maxConcurrency: props.maxConcurrency,
    maxDeriskRounds: props.maxDeriskRounds,
    poll: props.poll,
    budget: props.budget,
    scorers: props.scorers,
  };
  const phases = React.createElement(
    Sequence,
    { label: "delegation-chain" },
    React.createElement(GoalRefinement, {
      ...shared,
      prompt: props.prompt,
      maxQuestions: props.maxQuestions,
      prefetchDepth: props.prefetchDepth,
    }),
    React.createElement(DelegationPlanning, shared),
    React.createElement(DelegationPreview, shared),
    React.createElement(BackpressurePlanning, shared),
    React.createElement(DeriskLoop, shared),
    React.createElement(DelegationExecution, { ...shared, maxAttempts: props.maxAttempts }),
    React.createElement(DelegationScoring, shared),
  );
  const body = React.createElement(
    Parallel,
    { label: "delegation-chain (with edit listener)" },
    phases,
    React.createElement(DelegationEditListener, { ...shared, maxEdits: props.maxEdits }),
  );
  if (props.budget?.maxMinutes !== undefined) {
    return React.createElement(
      Aspects,
      {
        latencySlo: { maxMs: props.budget.maxMinutes * 60_000, onExceeded: "fail" },
      },
      body,
    );
  }
  return body;
}
