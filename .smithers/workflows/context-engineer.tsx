// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Context Engineer
// smithers-description: Turn a vague user script into a context contract, route it to skills/workflows, add backpressure, execute, and report — the concierge proxy.
// smithers-tags: concierge, context-engineering, planning
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import { GrillMe, grillOutputSchema } from "../components/GrillMe";
import ClassifyPrompt from "../prompts/context-engineer-classify.mdx";
import InventoryPrompt from "../prompts/context-engineer-inventory.mdx";
import RoutePrompt from "../prompts/context-engineer-route.mdx";
import BackpressurePrompt from "../prompts/context-engineer-backpressure.mdx";
import ExecutePrompt from "../prompts/context-engineer-execute.mdx";
import ReportPrompt from "../prompts/context-engineer-report.mdx";

const SKILLS_DIR = ".smithers/skills";
const WORKFLOWS_DIR = ".smithers/workflows";

// The durable, seeded workflows the concierge can route the script to. Keep this
// loosely in sync with the workflows actually present in .smithers/workflows/.
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
  "context-doctor",
  "backpressure-plan",
  "route-task",
  "report-slideshow",
  "monitor-smithers",
] as const;

const inputSchema = z.object({
  prompt: z
    .string()
    .default("Describe what you want Smithers to do, in plain English.")
    .describe("The vague user script the concierge turns into a context contract and then executes."),
  review: z
    .boolean()
    .default(true)
    .describe("Pause for human approval of the context contract before any work is executed."),
});

// 1. The classifier's read on the script: which modes it touches, and whether it
//    earns the overhead of a durable workflow.
const classifySchema = z.looseObject({
  modes: z
    .array(z.string())
    .default([])
    .describe("The task modes the script maps onto (e.g. research, planning, implementation, debugging, report)."),
  durable: z
    .boolean()
    .describe("True when the work needs ordering, crash-recovery, approvals, or loops — i.e. a real workflow."),
  reason: z.string().default("").describe("One or two sentences justifying the modes + durable call."),
});

// 2. The context contract draft — the heart of the proxy. The inventory step
//    inspects the repo, tools, and .smithers/skills to fill this in.
const contractSchema = z.looseObject({
  goal: z.string().describe("One sentence: the outcome the script is really after."),
  nonGoals: z.array(z.string()).default([]).describe("Explicitly out of scope, to stop drift."),
  assumptions: z.array(z.string()).default([]).describe("Reasonable assumptions made to fill gaps in the script."),
  inputs: z
    .array(z.looseObject({ name: z.string(), source: z.string().default(""), value: z.string().default("") }))
    .default([])
    .describe("Inputs the work needs and where each comes from."),
  missingInputs: z.array(z.string()).default([]).describe("Inputs the script is missing — candidates for grilling."),
  availableTools: z.array(z.string()).default([]).describe("Tools/commands available to do the work."),
  availableSkills: z.array(z.string()).default([]).describe("Relevant skills found under .smithers/skills."),
  constraints: z.array(z.string()).default([]).describe("Hard constraints the work must respect."),
  risks: z.array(z.string()).default([]).describe("Risks or side effects to guard against."),
  desiredArtifacts: z.array(z.string()).default([]).describe("Concrete artifacts a successful run should produce."),
  successCriteria: z.array(z.string()).default([]).describe("How we know the work is done."),
  verificationSignals: z
    .array(z.string())
    .default([])
    .describe("Observable signals (tests, traces, reviews) that prove each success criterion."),
});

// 3. The grill output — reuses GrillMe's schema so the component can write to it.
//    Used to resolve blocking ambiguity, one question at a time.

// 4. The router's decision: how to actually carry out the contracted work.
const routeSchema = z.looseObject({
  selectedRoute: z
    .enum(["single_task", "skills", "workflow", "manual"])
    .describe("How the work is carried out: a one-shot task, a set of skills, a durable workflow, or hand to a human."),
  selectedSkills: z.array(z.string()).default([]).describe("Skills the executor should load, best-first."),
  selectedWorkflow: z
    .string()
    .nullable()
    .default(null)
    .describe("If routed to a durable workflow, the single best-fit seeded workflow id; otherwise null."),
  durableRequired: z.boolean().default(false).describe("True when the route genuinely needs durable execution."),
  humanApprovalRequired: z.boolean().default(false).describe("True when a human gate is needed before side effects."),
  reason: z.string().default("").describe("Why this route fits the contract and classification."),
});

// 5. The backpressure gate matrix — every success criterion mapped to how it is
//    verified and enforced, so the executor cannot just try-its-best and move on.
const backpressureSchema = z.looseObject({
  gates: z
    .array(
      z.looseObject({
        criterion: z.string().describe("The success criterion this gate enforces."),
        verificationMethod: z
          .enum([
            "schema",
            "unit_test",
            "integration_test",
            "eval",
            "review",
            "approval",
            "trace",
            "manual_check",
          ])
          .describe("How the criterion is checked."),
        gateType: z
          .enum(["blocking", "warning", "informational"])
          .describe("blocking stops the run; warning flags; informational only records."),
        failureAction: z.string().describe("What happens when this gate fails."),
        evidenceRequired: z
          .array(z.string())
          .default([])
          .describe("Concrete artifacts that prove the gate passed (logs, diffs, reports, traces)."),
      }),
    )
    .default([])
    .describe("One gate per success criterion; every blocking criterion names a verification method."),
  summary: z.string().default("").describe("2-3 sentence overview of the backpressure plan."),
});

// Durable human approval decision (matches the Approval component's output shape).
const approvalSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
});

// 7. The execution step's report of what it did or dispatched.
const executeSchema = z.looseObject({
  summary: z.string().describe("What was done or dispatched this iteration."),
  done: z.boolean().describe("True when the contracted work is fully carried out."),
  artifacts: z.array(z.string()).default([]).describe("Files written, outputs produced, or workflows dispatched."),
});

// 8. The final HTML slideshow-style report of the whole concierge run.
const reportSchema = z.looseObject({
  html: z.string().describe("A complete, self-contained HTML slideshow report (inline CSS, no external deps)."),
  summary: z.string().default("").describe("One-line summary of the run for the CLI."),
});

const { Workflow, Task, Sequence, Branch, Ralph, Approval, smithers, outputs } = createSmithers({
  input: inputSchema,
  classify: classifySchema,
  inventory: contractSchema,
  grill: grillOutputSchema,
  route: routeSchema,
  backpressure: backpressureSchema,
  approval: approvalSchema,
  execute: executeSchema,
  report: reportSchema,
});

export default smithers((ctx) => {
  // Input fields arrive null (not the zod default) when unsupplied, and the
  // approval gate is documented as default-ON — coalesce so it actually is.
  const review = ctx.input.review ?? true;
  const prompt = ctx.input.prompt ?? "Describe what you want Smithers to do, in plain English.";

  const classify = ctx.outputMaybe("classify", { nodeId: "classify-script" });
  const contract = ctx.outputMaybe("inventory", { nodeId: "inventory-context" });
  const route = ctx.outputMaybe("route", { nodeId: "route" });
  const backpressure = ctx.outputMaybe("backpressure", { nodeId: "build-backpressure" });
  const approval = ctx.outputMaybe("approval", { nodeId: "approve-contract" });

  // Grill bookkeeping: the latest answer from the one-question-at-a-time loop.
  const grills = ctx.outputs.grill ?? [];
  const lastGrill = grills.at(-1);
  const grillResolved = lastGrill?.resolved === true;

  // The contract is "designed" once it has been drafted and grilling has settled.
  const designed = contract !== undefined && backpressure !== undefined;
  const approved = !review || approval?.approved === true;
  const proceed = designed && approved;

  // Execute-loop bookkeeping: re-render the `until` against the latest execute output.
  const executeOutputs = ctx.outputs.execute ?? [];
  const lastExecute = executeOutputs.at(-1);
  const executed = lastExecute?.done === true;

  return (
    <Workflow name="context-engineer">
      <Sequence>
        {/* 1 — Classify the vague script into modes + a durability call. */}
        <Task id="classify-script" output={outputs.classify} agent={agents.cheapFast}>
          <ClassifyPrompt prompt={prompt} workflows={SEEDED_WORKFLOWS} />
        </Task>

        {/* 2 — Inventory the repo/tools/skills into a context contract draft. */}
        {classify ? (
          <Task
            id="inventory-context"
            output={outputs.inventory}
            agent={agents.smartTool}
            heartbeatTimeoutMs={600_000}
          >
            <InventoryPrompt
              prompt={prompt}
              classification={classify}
              skillsDir={SKILLS_DIR}
              workflowsDir={WORKFLOWS_DIR}
            />
          </Task>
        ) : null}

        {/* 3 — Resolve blocking ambiguity by grilling, one question at a time,
            with a recommended answer each time. Reuses the GrillMe component. */}
        {contract ? (
          <GrillMe
            idPrefix="context-engineer"
            context={`We are turning a vague user script into a context contract before executing it. Grill me only on the BLOCKING ambiguities that would change the work — prefer the contract's missingInputs and openest assumptions. Ask one question at a time with a recommended answer, and mark resolved: true once the remaining ambiguity no longer changes the plan.\n\n## Original script\n${prompt}\n\n## Context contract draft\n\`\`\`json\n${JSON.stringify(contract, null, 2)}\n\`\`\``}
            currentDraft={lastGrill ?? null}
            agent={agents.smart}
            output={outputs.grill}
            maxIterations={5}
            until={grillResolved}
          />
        ) : null}

        {/* 4 — Route the contracted work: single task, skills, durable workflow, or human. */}
        {contract ? (
          <Task id="route" output={outputs.route} agent={agents.smart}>
            <RoutePrompt
              prompt={prompt}
              classification={classify}
              contract={contract}
              sharedUnderstanding={lastGrill?.sharedUnderstanding ?? null}
              workflows={SEEDED_WORKFLOWS}
            />
          </Task>
        ) : null}

        {/* 5 — Turn the success criteria into a backpressure gate matrix. */}
        {route ? (
          <Task id="build-backpressure" output={outputs.backpressure} agent={agents.smart}>
            <BackpressurePrompt prompt={prompt} contract={contract} route={route} />
          </Task>
        ) : null}

        {/* 6 — Optional durable human approval of the whole contract before executing. */}
        <Branch
          if={review && designed}
          then={
            <Approval
              id="approve-contract"
              output={outputs.approval}
              request={{
                title: `Approve context contract: ${contract?.goal ?? prompt}`.slice(0, 120),
                summary:
                  backpressure?.summary ??
                  "Review the context contract, route, and backpressure gates before any work is executed.",
              }}
            />
          }
          else={null}
        />

        {/* 7 — Execute (or dispatch) the contracted work, looping until done. */}
        {proceed ? (
          <Ralph id="execute:loop" until={executed} maxIterations={3} onMaxReached="return-last">
            <Task
              id="execute"
              output={outputs.execute}
              agent={agents.smartTool}
              heartbeatTimeoutMs={900_000}
            >
              <ExecutePrompt
                prompt={prompt}
                contract={contract}
                route={route}
                backpressure={backpressure}
                previous={lastExecute ?? null}
              />
            </Task>
          </Ralph>
        ) : null}

        {/* 8 — Report the whole concierge run as a self-contained HTML slideshow. */}
        {proceed && executed ? (
          <Task id="report" output={outputs.report} agent={agents.smart}>
            <ReportPrompt
              prompt={prompt}
              classification={classify}
              contract={contract}
              route={route}
              backpressure={backpressure}
              approval={approval ?? null}
              execution={lastExecute ?? null}
              sharedUnderstanding={lastGrill?.sharedUnderstanding ?? null}
            />
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
