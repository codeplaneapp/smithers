// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Route Task
// smithers-description: Classify a plain-English script and either run it as a single task or recommend the right durable workflow.
// smithers-tags: concierge, routing
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import ClassifyPrompt from "../prompts/route-task-classify.mdx";
import ExecutePrompt from "../prompts/route-task-execute.mdx";
import RecommendPrompt from "../prompts/route-task-recommend.mdx";

// The seeded, durable workflows the concierge can hand off to. Keep this in sync
// with the workflows actually present in .smithers/workflows/.
const SEEDED_WORKFLOWS = [
  "implement",
  "research-plan-implement",
  "review",
  "plan",
  "research",
  "grill-me",
  "ralph",
  "debug",
  "audit",
  "create-workflow",
  "create-skill",
  "extract-skill",
  "context-doctor",
  "monitor-smithers",
  "triage-run",
  "report-slideshow",
  "eval-author",
  "improve-test-coverage",
] as const;

const DEFAULT_PROMPT = "Describe the task you want Smithers to handle, in plain English.";

const inputSchema = z.object({
  prompt: z
    .string()
    .default(DEFAULT_PROMPT)
    .describe("Plain-English description of the task to route — run directly or hand to a durable workflow."),
});

// 1. The classifier's verdict: what kind of task this is, and whether it needs a
//    durable workflow (ordering, crash-recovery, approvals, loops) or can run as
//    a single one-shot task. recommendedWorkflow is enum-enforced so a
//    hallucinated workflow id fails validation instead of flowing downstream.
const classifySchema = z.looseObject({
  mode: z
    .enum([
      "single_task",
      "research",
      "planning",
      "implementation",
      "debugging",
      "report",
      "data_extraction",
      "multi_step",
    ])
    .describe("The task mode the script maps onto."),
  durable: z
    .boolean()
    .describe("True when the task needs ordering, crash-recovery, approvals, or loops — i.e. a real workflow."),
  recommendedWorkflow: z
    .enum(SEEDED_WORKFLOWS)
    .nullable()
    .default(null)
    .describe("If durable, the best-fit seeded workflow id from the catalog; otherwise null."),
  reason: z.string().describe("One or two sentences justifying the mode + durable call."),
});

// 2a. Non-durable path: the work was actually done in a single task.
const executeSchema = z.looseObject({
  summary: z.string().describe("What was done, in a sentence or two."),
  done: z.boolean().describe("True when the task was fully completed in this single step."),
});

// 2b. Durable path: a pointer at the right seeded workflow to run instead.
const recommendSchema = z.looseObject({
  recommendedWorkflow: z
    .enum(SEEDED_WORKFLOWS)
    .describe("The single best-fit seeded workflow id to run."),
  why: z.string().describe("Why this workflow fits the task — what durable behaviour it provides."),
  alternativeWorkflows: z
    .array(z.enum(SEEDED_WORKFLOWS))
    .default([])
    .describe("Other seeded workflows that could also fit, best-first."),
});

const { Workflow, Task, Sequence, Branch, smithers, outputs } = createSmithers({
  input: inputSchema,
  classify: classifySchema,
  execute: executeSchema,
  recommend: recommendSchema,
});

export default smithers((ctx) => {
  // Input fields arrive null (not the zod default) when unsupplied — coalesce
  // so the classifier never sees an empty task section.
  const prompt = ctx.input.prompt ?? DEFAULT_PROMPT;
  const classify = ctx.outputMaybe("classify", { nodeId: "classify" });

  // Gate the two paths on the classifier's verdict. Only one branch runs.
  const classified = classify !== undefined;
  const durable = classify?.durable === true;

  return (
    <Workflow name="route-task">
      <Sequence>
        {/* 1 — Classify the script into a mode and decide whether it needs a durable workflow. */}
        <Task id="classify" output={outputs.classify} agent={agents.cheapFast}>
          <ClassifyPrompt prompt={prompt} workflows={SEEDED_WORKFLOWS} />
        </Task>

        {/* 2 — Branch: run it directly (non-durable) or recommend a durable workflow. */}
        {classified ? (
          <Branch
            if={durable}
            then={
              <Task id="recommend" output={outputs.recommend} agent={agents.smart}>
                <RecommendPrompt
                  prompt={prompt}
                  classification={classify}
                  workflows={SEEDED_WORKFLOWS}
                />
              </Task>
            }
            else={
              <Task id="execute" output={outputs.execute} agent={agents.smartTool}>
                <ExecutePrompt prompt={prompt} classification={classify} />
              </Task>
            }
          />
        ) : null}
      </Sequence>
    </Workflow>
  );
});
