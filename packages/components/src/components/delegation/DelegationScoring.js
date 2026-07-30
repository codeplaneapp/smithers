// @smithers-type-exports-begin
/** @typedef {import("./DelegationScoringProps.ts").DelegationScoringProps} DelegationScoringProps */
// @smithers-type-exports-end

import React from "react";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { Sequence } from "../Sequence.js";
import { Task } from "../Task.js";
import { HumanTask } from "../HumanTask.js";
import { dcPollSchema } from "./delegationSchemasRuntime.js";
import {
  actualTotals,
  executionComplete,
  foldGates,
  foldPlans,
  latestRow,
  nodeIndex,
  physicalId,
  readRows,
  synthesizeDelegationEvents,
} from "./delegationState.js";
import { pollPrompt } from "./delegationPrompts.js";

/**
 * <DelegationScoring> — end-of-run scoring + human poll (frame 10).
 *
 * Per-task scorers ride the exec/review tasks inside DelegationExecution
 * (`scorers.exec` / `scorers.review`); this composite adds the run level.
 * When `poll` is enabled, the 3-question satisfaction poll HumanTask
 * (`<p>:root:poll`) mounts FIRST — the run's final attention badge — and the
 * run-score task (`<p>:root:score`) mounts only after the poll row lands, so
 * `humanPollScorer` sees the submitted poll instead of always skipping.
 *
 * The score task carries the caller's `scorers.run` (e.g. built from
 * `delegationRunScore` in `smithers-orchestrator/scorers`) and a `context`
 * synthesized to the exact shapes those scorers parse:
 * - `events` + `nodes` — a faithful DelegationEvent[] log derived from the
 *   dc* rows (see `synthesizeDelegationEvents`) for pocJudgment/planSolidity;
 * - `plan` + `exec` — the raw dcPlan/dcExec rows for estimateAccuracy;
 * - `poll` — the poll's `{ question, answer }` entries for humanPoll;
 * - `tier`/`brief`/`stats` — the root node descriptor for tierFit.
 * @param {DelegationScoringProps} props
 */
export function DelegationScoring(props) {
  const ctx = React.useContext(SmithersContext);
  if (props.skipIf) return null;
  const p = props.idPrefix ?? "dc";
  const o = props.outputs;
  const poll = props.poll ?? true;
  const planRows = readRows(ctx, o.dcPlan);
  const plans = foldPlans(planRows);
  const gates = foldGates(readRows(ctx, o.dcGates));
  const execRows = readRows(ctx, o.dcExec);
  const reviewRows = readRows(ctx, o.dcReview);
  const probeRows = readRows(ctx, o.dcProbe);
  const replanRows = readRows(ctx, o.dcReplan);
  const approvalRows = readRows(ctx, o.dcApproval ?? "dcApproval");
  const devPreviewRows = readRows(ctx, o.dcDevPreview ?? "dcDevPreview");
  const pollRows = readRows(ctx, o.dcPoll);
  const done = executionComplete({
    idPrefix: p,
    plans,
    gates,
    approvalPolicy: props.approvalPolicy,
    execRows,
    reviewRows,
    approvalRows,
    devPreviewRows,
    replanRows,
    maxDeriskRounds: props.maxDeriskRounds,
  });
  if (!done) return null;
  const children = [];
  if (poll) {
    const pollId = physicalId(p, "root", "poll");
    // Keyed Fragment wrapper: React's `key` is a special prop handled by
    // createElement — it never reaches props — so key the wrapper, not the
    // HumanTask element.
    children.push(
      React.createElement(
        React.Fragment,
        { key: pollId },
        React.createElement(HumanTask, {
          id: pollId,
          output: o.dcPoll,
          outputSchema: dcPollSchema,
          label: "delegation: satisfaction poll",
          prompt: pollPrompt(),
        }),
      ),
    );
  }
  // The run-score task mounts once the poll is answered (or disabled), so
  // its context always carries every scorer input, poll included.
  if (!poll || pollRows.length > 0) {
    const scoreId = physicalId(p, "root", "score");
    const rootPlan = plans.get("root")?.plan;
    const rootEstimate = rootPlan?.subtreeEstimate;
    const totals = actualTotals(execRows);
    const digest = {
      nodesPlanned: plans.size,
      planVersions: planRows.length,
      probes: probeRows.length,
      probesChangedPlan: probeRows.filter((row) => row.planImpact === "changes").length,
      replans: replanRows.length,
      invalidations: replanRows.filter((row) => row.decision === "invalidated").length,
      execAttempts: execRows.length,
      reviewFailures: reviewRows.filter((row) => row.verdict === "fail").length,
      predicted: rootEstimate ?? null,
      actual: totals,
    };
    const pollRow = latestRow(pollRows);
    const pollAnswers = Array.isArray(pollRow?.answers)
      ? pollRow.answers.map((entry) => ({
          question: String(entry?.question ?? ""),
          answer: entry?.rating,
        }))
      : undefined;
    const runContext = {
      events: synthesizeDelegationEvents({ planRows, probeRows, replanRows, execRows, reviewRows, devPreviewRows }),
      nodes: [...nodeIndex(plans).values()].map((node) => ({
        id: node.logicalId,
        kind: node.kind,
        tier: node.tier,
        brief: node.brief,
      })),
      plan: planRows,
      exec: execRows,
      ...(pollAnswers ? { poll: pollAnswers } : {}),
      ...(rootPlan ? { tier: rootPlan.tier, brief: rootPlan.brief } : {}),
      stats: { predicted: rootEstimate ?? null, actual: totals },
      digest,
    };
    children.push(
      React.createElement(Task, {
        key: scoreId,
        id: scoreId,
        output: o.dcScore ?? "dcScore",
        scorers: props.scorers?.run,
        context: runContext,
        label: "delegation: run score",
        children: () => ({
          logicalId: "root",
          summary: JSON.stringify(digest),
        }),
      }),
    );
  }
  return React.createElement(Sequence, { label: "delegation: scoring" }, ...children);
}
