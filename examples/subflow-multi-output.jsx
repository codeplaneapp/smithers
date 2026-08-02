/**
 * <Subflow mode="childRun"> — which value does the parent get when the child
 * writes MULTIPLE output tables?
 *
 * The child below writes three tables (draft → stats → decision) and declares
 * `decision` — its FINAL task's table — as the workflow output. In childRun
 * mode the parent receives the child's normalized run output: the final task's
 * row (one row → that row, system columns stripped; several rows → an array;
 * none → null). It is NOT a table-keyed snapshot like
 * `{ draft: [...], stats: [...], decision: [...] }`.
 *
 * The parent Subflow's `output` schema therefore matches the child's FINAL
 * task schema — adding or changing the child's final task changes the shape
 * the parent must expect.
 *
 * Agent-free (every task is a compute task), so it runs without API keys:
 *   smithers up examples/subflow-multi-output.jsx --input '{"topic":"release notes"}'
 *
 * The executable proof of this contract lives in
 * packages/engine/tests/subflow-childrun-multi-output.e2e.test.jsx.
 */
import { Sequence, Subflow } from "smthrs";
import { createExampleSmithers } from "./_example-kit.js";
import { z } from "zod";
const draftSchema = z.object({ text: z.string() });
const statsSchema = z.object({ wordCount: z.number() });
// The child's FINAL task row — this exact shape is what a childRun parent receives.
const decisionSchema = z.object({
    decision: z.string(),
    wordCount: z.number(),
});
// Same shape as the child's final task: where the parent persists that row.
const subflowDecisionSchema = z.object({
    decision: z.string(),
    wordCount: z.number(),
});
const announcementSchema = z.object({ headline: z.string() });
const { Workflow, Task, smithers, outputs } = createExampleSmithers({
    draft: draftSchema,
    stats: statsSchema,
    decision: decisionSchema,
    subflowDecision: subflowDecisionSchema,
    announcement: announcementSchema,
});
// A child with THREE output tables and a distinct final task. Only the final
// task's table (`decision`, declared via `{ output: outputs.decision }`) flows
// back to the parent; `draft` and `stats` stay scoped to the child run.
const childWorkflow = smithers((ctx) => (<Workflow name="multi-output-child">
    <Sequence>
      <Task id="draft" output={outputs.draft}>
        {{ text: `Draft about ${ctx.input.topic ?? "smithers subflows"}` }}
      </Task>
      <Task id="stats" output={outputs.stats} deps={{ draft: outputs.draft }}>
        {(deps) => ({ wordCount: deps.draft.text.trim().split(/\s+/).length })}
      </Task>
      {/* Final task: its row is the childRun output the parent receives. */}
      <Task id="decision" output={outputs.decision} deps={{ draft: outputs.draft, stats: outputs.stats }}>
        {(deps) => ({
        decision: deps.stats.wordCount >= 3 ? "publish" : "expand",
        wordCount: deps.stats.wordCount,
    })}
      </Task>
    </Sequence>
  </Workflow>), { output: outputs.decision });
export default smithers((ctx) => (<Workflow name="subflow-multi-output">
    <Sequence>
      {/* The Subflow's output schema matches the child's FINAL task, not a
        snapshot of every table the child wrote. */}
      <Subflow id="review" mode="childRun" workflow={childWorkflow} input={{ topic: ctx.input.topic ?? "smithers subflows" }} output={outputs.subflowDecision}/>
      {/* Parent consumption: deps.review is the child's final task row. */}
      <Task id="announce" output={outputs.announcement} deps={{ review: outputs.subflowDecision }}>
        {(deps) => ({
        headline: `Child decided "${deps.review.decision}" at ${deps.review.wordCount} words`,
    })}
      </Task>
    </Sequence>
  </Workflow>));
