// smithers-source: authored
// smithers-display-name: Dynamic Task Demo
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";

const inputSchema = z.object({
  delayMs: z.number().int().min(0).max(30000).default(3000),
  maxIterations: z.number().int().min(1).max(500).default(120),
});

const phaseSchema = z.object({
  cycle: z.number().int(),
  phase: z.string(),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  active: z.array(z.string()),
  summary: z.string(),
});

const stepSchema = z.object({
  cycle: z.number().int(),
  phase: z.string(),
  step: z.string(),
  summary: z.string(),
});

const { Workflow, Task, Sequence, Parallel, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  phase: phaseSchema,
  step: stepSchema,
});

type Stage = {
  id: string;
  title: string;
  steps: Array<{ id: string; title: string; summary: string }>;
};

const stages: Stage[] = [
  {
    id: "intake",
    title: "Intake",
    steps: [
      { id: "read-context", title: "Read Context", summary: "Review the demo brief and current run state." },
      { id: "inventory-files", title: "Inventory Files", summary: "List the docs and tickets that would be inspected." },
    ],
  },
  {
    id: "fanout",
    title: "Fan Out Review",
    steps: [
      { id: "docs-pass", title: "Docs Pass", summary: "Check documentation structure and headings." },
      { id: "tests-pass", title: "Tests Pass", summary: "Check existing test coverage targets." },
      { id: "api-pass", title: "API Pass", summary: "Review command and schema surfaces." },
      { id: "gui-pass", title: "GUI Pass", summary: "Review the DevTools task tree expectations." },
    ],
  },
  {
    id: "narrow",
    title: "Narrow Focus",
    steps: [
      { id: "risk-summary", title: "Risk Summary", summary: "Collapse the fan-out into the highest signal risks." },
    ],
  },
  {
    id: "handoff",
    title: "Handoff",
    steps: [
      { id: "demo-notes", title: "Demo Notes", summary: "Prepare notes for the next visible state change." },
      { id: "cleanup-queue", title: "Cleanup Queue", summary: "Remove completed work from the active set." },
      { id: "next-cycle", title: "Next Cycle", summary: "Seed the next intake cycle." },
    ],
  },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
const stepNames = (stage: Stage) => stage.steps.map((step) => step.title);

export default smithers((ctx) => {
  const delayMs = ctx.input.delayMs ?? 3000;
  const maxIterations = ctx.input.maxIterations ?? 120;
  const iteration = ctx.iteration;
  const stage = stages[iteration % stages.length];
  const previousStage = iteration === 0 ? null : stages[(iteration - 1) % stages.length];
  const added = previousStage ? stepNames(stage).filter((name) => !stepNames(previousStage).includes(name)) : stepNames(stage);
  const removed = previousStage ? stepNames(previousStage).filter((name) => !stepNames(stage).includes(name)) : [];

  return (
    <Workflow name="dynamic-demo">
      <Loop id="dynamic-task-tree" until={false} maxIterations={maxIterations} onMaxReached="return-last">
        <Sequence>
          <Task id={`dynamic:${stage.id}:announce`} output={outputs.phase}>
            {async () => {
              await sleep(delayMs);
              return {
                cycle: iteration,
                phase: stage.title,
                added,
                removed,
                active: stepNames(stage),
                summary:
                  iteration === 0
                    ? `Starting with ${stage.title}; adding ${added.join(", ")}.`
                    : `Switching from ${previousStage?.title} to ${stage.title}; adding ${added.join(", ") || "none"} and removing ${removed.join(", ") || "none"}.`,
              };
            }}
          </Task>

          <Parallel maxConcurrency={2}>
            {stage.steps.map((step, index) => (
              <Task key={step.id} id={`dynamic:${stage.id}:${step.id}`} output={outputs.step}>
                {async () => {
                  await sleep(delayMs + index * 450);
                  return {
                    cycle: iteration,
                    phase: stage.title,
                    step: step.title,
                    summary: step.summary,
                  };
                }}
              </Task>
            ))}
          </Parallel>
        </Sequence>
      </Loop>

      <Task id="dynamic:complete" output={outputs.step}>
        {{
          cycle: maxIterations,
          phase: "Complete",
          step: "Demo Complete",
          summary: "Dynamic task tree demo finished after the requested iterations.",
        }}
      </Task>
    </Workflow>
  );
});
