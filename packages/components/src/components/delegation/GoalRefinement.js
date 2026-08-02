// @smithers-type-exports-begin
/** @typedef {import("./GoalRefinementProps.ts").GoalRefinementProps} GoalRefinementProps */
// @smithers-type-exports-end

import React from "react";
import { SmithersContext } from "@smthrs/react-reconciler/context";
import { Sequence } from "../Sequence.js";
import { Parallel } from "../Parallel.js";
import { Task } from "../Task.js";
import { HumanTask } from "../HumanTask.js";
import { DEFAULT_TIER_ORDER, dcGoalApprovalSchema } from "./delegationSchemasRuntime.js";
import { agentForTier, latestRow, readRows, rowsForNode } from "./delegationState.js";
import { DelegationQuestionTask } from "./DelegationQuestionTask.js";
import {
  answerPrompt,
  goalApprovalPrompt,
  goalQuestionsPrompt,
  goalRefinePrompt,
  questionFormPrompt,
} from "./delegationPrompts.js";

/**
 * <GoalRefinement> — phase 0 of the delegation chain.
 *
 * The strongest tier forecasts every genuine user-preference question upfront
 * (one dcForecast row); haiku tasks render form metadata (unresolved
 * dcQuestion rows) up to `prefetchDepth` questions ahead; the user answers one
 * durable json form at a time (each answer folds into a RESOLVED dcQuestion
 * row); then the goal agent writes the refined prompt (dcGoal) and a final
 * HumanTask lets the human edit + approve it (`{ approved, refinedPrompt }` —
 * the approved refinedPrompt is what planning builds from).
 *
 * Node ids: `<p>:goal:forecast` (internal), `<p>:goal:forms:question-<seq>`
 * (haiku form metadata), `<p>:goal:question-<seq>` (human answer — the id the
 * delegation UI targets), `<p>:goal:goal` (refine), `<p>:goal:approve`
 * (refined-prompt approval — UI-targeted).
 * @param {GoalRefinementProps} props
 */
export function GoalRefinement(props) {
  const ctx = React.useContext(SmithersContext);
  if (props.skipIf) return null;
  const p = props.idPrefix ?? "dc";
  const o = props.outputs;
  const tierOrder = props.tierOrder ?? [...DEFAULT_TIER_ORDER];
  const maxQuestions = props.maxQuestions ?? 10;
  const prefetchDepth = props.prefetchDepth ?? 10;
  const maxConcurrency = props.maxConcurrency ?? 4;
  const goalAgent = agentForTier(props.agents, tierOrder[0], tierOrder);
  const formAgent = agentForTier(props.agents, tierOrder[tierOrder.length - 1], tierOrder);
  const forecastId = `${p}:goal:forecast`;
  const refineId = `${p}:goal:goal`;
  const approveId = `${p}:goal:approve`;
  const forecast = latestRow(rowsForNode(readRows(ctx, o.dcForecast), forecastId));
  const questionRows = readRows(ctx, o.dcQuestion);
  const goalRows = readRows(ctx, o.dcGoal);
  /** @type {Array<Record<string, any>>} */
  const questions = Array.isArray(forecast?.questions) ? forecast.questions : [];
  /** @param {number} seq */
  const formRowFor = (seq) => latestRow(rowsForNode(questionRows, `${p}:goal:forms:question-${seq}`));
  /** @param {number} seq */
  const answerFor = (seq) => latestRow(rowsForNode(questionRows, `${p}:goal:question-${seq}`));
  const maxAnswered = questions.reduce((max, q) => (answerFor(Number(q.seq)) ? Math.max(max, Number(q.seq)) : max), 0);
  const allAnswered = questions.every((q) => answerFor(Number(q.seq)) !== undefined);
  const children = [];
  // 1. Upfront question forecast (one internal row carries the whole batch).
  children.push(
    React.createElement(Task, {
      key: forecastId,
      id: forecastId,
      output: o.dcForecast,
      agent: goalAgent,
      label: "goal: forecast questions",
      children: goalQuestionsPrompt({
        prompt: props.prompt,
        maxQuestions,
        approvalPolicy: props.approvalPolicy,
      }),
    }),
  );
  if (forecast) {
    // 2. Haiku form prefetch — unresolved dcQuestion rows rendered up to
    // prefetchDepth questions ahead of the highest answered seq.
    const prefetch = questions
      .filter((q) => Number(q.seq) <= maxAnswered + prefetchDepth)
      .map((q) =>
        React.createElement(Task, {
          key: `${p}:goal:forms:question-${q.seq}`,
          id: `${p}:goal:forms:question-${q.seq}`,
          output: o.dcQuestion,
          agent: formAgent,
          label: `goal: render form q${q.seq}`,
          children: questionFormPrompt({ question: q }),
        }),
      );
    if (prefetch.length > 0) {
      children.push(React.createElement(Parallel, { key: `${p}:goal:prefetch`, maxConcurrency }, ...prefetch));
    }
    // 3. One human question at a time (grill pattern): question n mounts
    // once its form metadata exists and every earlier question is answered.
    for (const q of questions) {
      const seq = Number(q.seq);
      const form = formRowFor(seq);
      const previousAnswered = questions
        .filter((other) => Number(other.seq) < seq)
        .every((other) => answerFor(Number(other.seq)) !== undefined);
      if (!form || !previousAnswered) continue;
      // Keyed Fragment wrappers around human tasks: React's `key` is a
      // special prop handled by createElement — it never reaches props — so
      // key the wrapper, not the task element.
      children.push(
        React.createElement(
          React.Fragment,
          { key: `${p}:goal:question-${seq}` },
          React.createElement(DelegationQuestionTask, {
            id: `${p}:goal:question-${seq}`,
            output: o.dcQuestion,
            form,
            label: `goal: question ${seq} of ${forecast.total}`,
            prompt: answerPrompt({ question: form }),
          }),
        ),
      );
    }
    // 4. Refine once every forecast question is answered.
    if (allAnswered) {
      children.push(
        React.createElement(Task, {
          key: refineId,
          id: refineId,
          output: o.dcGoal,
          agent: goalAgent,
          label: "goal: refine prompt",
          children: goalRefinePrompt({
            prompt: props.prompt,
            qa: questions.map((q) => ({
              question: String(q.question ?? ""),
              answer: String(answerFor(Number(q.seq))?.recommended ?? ""),
            })),
            approvalPolicy: props.approvalPolicy,
          }),
        }),
      );
    }
    // 5. Human approves (and may edit) the refined prompt. The UI targets
    // `dc:goal:approve` and submits { approved, refinedPrompt }.
    const refined = latestRow(rowsForNode(goalRows, refineId));
    if (refined) {
      children.push(
        React.createElement(
          React.Fragment,
          { key: approveId },
          React.createElement(HumanTask, {
            id: approveId,
            output: o.dcGoalApproval,
            outputSchema: dcGoalApprovalSchema,
            label: "goal: approve refined prompt",
            prompt: goalApprovalPrompt({ goal: refined }),
          }),
        ),
      );
    }
  }
  return React.createElement(Sequence, { label: "delegation: goal refinement" }, ...children);
}
