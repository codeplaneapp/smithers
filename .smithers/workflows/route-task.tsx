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

// 3. Terminal summary: a small, human-meaningful digest of whatever path ran, so
//    the run's printed output (the LAST task) is useful instead of empty.
const outputSchema = z.object({
  mode: z.string().describe("The task mode the classifier picked."),
  durable: z.boolean().describe("Whether the task needed a durable workflow."),
  reason: z.string().describe("The classifier's justification."),
  outcome: z
    .enum(["executed", "recommended"])
    .describe("Whether the task was run directly or a durable workflow was recommended."),
  summary: z.string().nullable().default(null).describe("Non-durable path: what was done."),
  done: z.boolean().nullable().default(null).describe("Non-durable path: whether it fully completed."),
  recommendedWorkflow: z
    .string()
    .nullable()
    .default(null)
    .describe("Durable path: the best-fit seeded workflow to run."),
  why: z.string().nullable().default(null).describe("Durable path: why that workflow fits."),
  alternativeWorkflows: z
    .array(z.string())
    .default([])
    .describe("Durable path: other seeded workflows that could fit."),
});

const { Workflow, Task, Sequence, Branch, smithers, outputs } = createSmithers({
  input: inputSchema,
  classify: classifySchema,
  execute: executeSchema,
  recommend: recommendSchema,
  output: outputSchema,
});

export default smithers((ctx) => {
  // Input fields arrive null (not the zod default) when unsupplied — coalesce
  // so the classifier never sees an empty task section.
  const prompt = ctx.input.prompt ?? DEFAULT_PROMPT;
  const classify = ctx.outputMaybe("classify", { nodeId: "classify" });

  // Gate the two paths on the classifier's verdict. Only one branch runs.
  const classified = classify !== undefined;
  const durable = classify?.durable === true;

  // Pull whichever terminal output actually ran, so the final summary task can
  // aggregate the genuinely useful fields. Only the branch that matched exists.
  const execute = ctx.outputMaybe("execute", { nodeId: "execute" });
  const recommend = ctx.outputMaybe("recommend", { nodeId: "recommend" });
  const terminal = durable ? recommend : execute;
  const summaryReady = classified && terminal !== undefined;

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
              <Task id="execute" output={outputs.execute} agent={agents.implement}>
                <ExecutePrompt prompt={prompt} classification={classify} />
              </Task>
            }
          />
        ) : null}

        {/* 3 — Surface a concise, deterministic digest as the run's printed output. */}
        {summaryReady ? (
          <Task id="output" output={outputs.output}>
            {() => ({
              mode: classify?.mode ?? "single_task",
              durable,
              reason: classify?.reason ?? "",
              outcome: durable ? ("recommended" as const) : ("executed" as const),
              summary: execute?.summary ?? null,
              done: execute?.done ?? null,
              recommendedWorkflow:
                recommend?.recommendedWorkflow ?? classify?.recommendedWorkflow ?? null,
              why: recommend?.why ?? null,
              alternativeWorkflows: recommend?.alternativeWorkflows ?? [],
            })}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
