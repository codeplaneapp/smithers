// smithers-source: seeded
// smithers-metadata-version: 1
// smithers-display-name: Create Workflow
// smithers-description: Build a new Smithers workflow from a plain-English ask — clarify, provision docs & skills, design, scaffold, verify, and document.
// smithers-tags: authoring, workflow-pack, scaffolding
/** @jsxImportSource smithers-orchestrator */
import { $ } from "bun";
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { agents } from "../agents";
import ClarifyPrompt from "../prompts/create-workflow-clarify.mdx";
import ProvisionPrompt from "../prompts/create-workflow-provision.mdx";
import DesignPrompt from "../prompts/create-workflow-design.mdx";
import ScaffoldPrompt from "../prompts/create-workflow-scaffold.mdx";
import FixPrompt from "../prompts/create-workflow-fix.mdx";
import DocumentPrompt from "../prompts/create-workflow-document.mdx";

const WORKFLOWS_DIR = ".smithers/workflows";
const PROMPTS_DIR = ".smithers/prompts";
const SKILLS_DIR = ".smithers/skills";
const UI_DIR = ".smithers/ui";

const inputSchema = z.object({
  prompt: z
    .string()
    .default("Describe the workflow you want to build, in plain English.")
    .describe("Plain-English description of the workflow you want Smithers to build."),
  name: z
    .string()
    .nullable()
    .default(null)
    .describe("Desired kebab-case workflow id. Null lets the clarify/design steps choose one."),
  review: z
    .boolean()
    .default(true)
    .describe("Pause for human approval of the design before any files are written."),
});

// 1. The freeform ask, turned into a structured, buildable spec.
const clarifiedSpecSchema = z.looseObject({
  name: z.string().describe("Proposed kebab-case workflow id."),
  goal: z.string().describe("One sentence: what the finished workflow accomplishes."),
  trigger: z
    .string()
    .describe("How it starts: manual | push | schedule | issue | landing-request | workflow-run | webhook."),
  inputs: z
    .array(z.object({ name: z.string(), type: z.string(), purpose: z.string() }))
    .default([]),
  stages: z.array(z.string()).default([]).describe("Ordered high-level steps the workflow performs."),
  loops: z.array(z.string()).default([]).describe("Where it should iterate until a condition holds."),
  humanGates: z.array(z.string()).default([]).describe("Where a human approval / question belongs."),
  successCriteria: z.array(z.string()).default([]),
  ui: z
    .string()
    .default("")
    .describe("Desired custom UI / visualization for runs of this workflow (panels, live signals)."),
  clarifyingQuestions: z
    .array(
      z.object({
        question: z.string(),
        assumption: z.string().describe("The default assumed if the user does not answer."),
      }),
    )
    .default([])
    .describe(
      "Numbered questions put to the user (via ask-human when available, otherwise surfaced at the approval gate), each with the assumption used if unanswered.",
    ),
  openQuestions: z.array(z.string()).default([]).describe("Anything ambiguous the author should resolve."),
});

// 2. THE docs & skills step — what the new workflow (and the authoring agents)
//    need installed/available before it can be designed and built.
const provisioningSchema = z.looseObject({
  docsFragments: z
    .array(z.object({ name: z.string(), reason: z.string() }))
    .default([])
    .describe("smithers.sh llms-*.txt fragments pulled into context."),
  examples: z
    .array(z.object({ name: z.string(), reason: z.string() }))
    .default([])
    .describe("Closest examples/ workflows to copy as a starting template."),
  components: z
    .array(z.object({ name: z.string(), reason: z.string() }))
    .default([])
    .describe("Built-in or local components the new workflow should compose."),
  skills: z
    .array(
      z.object({
        name: z.string(),
        action: z.enum(["installed", "recommended", "present"]).default("recommended"),
        reason: z.string(),
      }),
    )
    .default([])
    .describe("Agent skills the workflow's workers need; installed ones were actually synced."),
  agents: z.array(z.string()).default([]).describe("Named agent pools / providers the workflow will use."),
  notes: z.string().default(""),
});

// 3. The concrete design the scaffolder will turn into real files.
const designSchema = z.looseObject({
  workflowName: z.string(),
  summary: z.string(),
  inputs: z
    .array(z.object({ name: z.string(), type: z.string(), default: z.string().nullable().default(null) }))
    .default([]),
  tasks: z
    .array(
      z.object({
        id: z.string(),
        purpose: z.string(),
        agent: z.string().describe("agents.smart | agents.smartTool | agents.cheapFast | (none) for a function task."),
        outputs: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  graphShape: z
    .string()
    .describe("How the JSX tree nests: Sequence/Parallel/Branch/Loop/Ralph/ReviewLoop, with gates and loops."),
  components: z.array(z.string()).default([]),
  prompts: z.array(z.string()).default([]).describe(".mdx prompt files to author alongside the workflow."),
  triggers: z.array(z.string()).default([]),
  humanGates: z.array(z.string()).default([]),
  ui: z
    .object({
      path: z.string().describe(".smithers/ui/<workflowName>.tsx"),
      summary: z.string().describe("What the custom run UI shows."),
      panels: z.array(z.string()).default([]).describe("Panels / sections and the node outputs they read."),
    })
    .nullable()
    .default(null)
    .describe("Plan for the custom gateway-react workflow UI. Required unless the user explicitly declined one."),
  rationale: z.string().default(""),
});

// Durable human approval decision (matches the Approval component's output shape).
const approvalSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
});

// 5 & 6. Files written by the scaffold / fix agents.
const scaffoldSchema = z.looseObject({
  summary: z.string(),
  workflowName: z.string(),
  filesWritten: z
    .array(
      z.object({
        path: z.string(),
        kind: z.enum(["workflow", "prompt", "component", "agents", "skill", "ui", "other"]).default("other"),
      }),
    )
    .default([]),
});

// 6. Result of rendering the new workflow's graph without executing it.
const verifySchema = z.looseObject({
  passed: z.boolean(),
  command: z.string(),
  errors: z.array(z.string()).default([]),
  notes: z.string().default(""),
});

// 7. Agent-facing skill doc so future agents know how to run the new workflow.
const documentSchema = z.looseObject({
  summary: z.string(),
  skillPath: z.string().nullable().default(null),
});

// 8. Final terminal summary — surfaced as the run's printed output so a finished
//    run reports what it built instead of nothing. Aggregated from the steps
//    above; nothing here is invented.
const outputSchema = z.object({
  workflow: z.string().describe("Workflow id that was built (or attempted)."),
  workflowFile: z.string().describe("Path to the scaffolded workflow .tsx."),
  status: z
    .string()
    .describe("Terminal status: built | verify-failed | denied | designed | incomplete."),
  summary: z.string().describe("One-line summary of what the run produced."),
  filesWritten: z.array(z.string()).default([]).describe("Paths the scaffolder wrote."),
  fileCount: z.number().default(0).describe("How many files were written."),
  verified: z.boolean().default(false).describe("Whether the new workflow's graph renders cleanly."),
  skillPath: z.string().nullable().default(null).describe("Agent skill doc written for the new workflow."),
  uiFile: z
    .string()
    .nullable()
    .default(null)
    .describe("Path to the scaffolded custom workflow UI, if one was written."),
  nextSteps: z
    .array(z.string())
    .default([])
    .describe(
      "Copy-pasteable commands the operator should suggest to the user next: run it, visualize it, open the custom UI, iterate.",
    ),
});

const { Workflow, Task, Sequence, Branch, Loop, Approval, smithers, outputs } = createSmithers({
  input: inputSchema,
  clarify: clarifiedSpecSchema,
  provision: provisioningSchema,
  design: designSchema,
  approval: approvalSchema,
  scaffold: scaffoldSchema,
  verify: verifySchema,
  document: documentSchema,
  output: outputSchema,
});

export default smithers((ctx) => {
  // Input fields arrive null (not the zod default) when unsupplied, and the
  // approval gate is documented as default-ON — coalesce so it actually is.
  const review = ctx.input.review ?? true;

  const clarify = ctx.outputMaybe("clarify", { nodeId: "clarify" });
  const provision = ctx.outputMaybe("provision", { nodeId: "provision" });
  const design = ctx.outputMaybe("design", { nodeId: "design" });
  const approval = ctx.outputMaybe("approval", { nodeId: "approve-design" });
  const scaffold = ctx.outputMaybe("scaffold", { nodeId: "scaffold" });
  const documentation = ctx.outputMaybe("document", { nodeId: "document" });

  const designed = design !== undefined;
  const approved = !review || approval?.approved === true;
  const proceed = designed && approved;

  // The name we scaffold + verify against, resolved as soon as it is known.
  const workflowName =
    scaffold?.workflowName ?? design?.workflowName ?? clarify?.name ?? ctx.input.name ?? "new-workflow";
  const workflowFile = `${WORKFLOWS_DIR}/${workflowName}.tsx`;
  const uiFile = `${UI_DIR}/${workflowName}.tsx`;

  // Verify-loop bookkeeping: re-render `until` against the latest verify output.
  const verifyOutputs = ctx.outputs.verify ?? [];
  const lastVerify = verifyOutputs.at(-1);
  const verifyPassed = lastVerify?.passed === true;
  const verifyFailed = lastVerify !== undefined && lastVerify.passed === false;

  // Terminal summary surfaced as the run's printed output. Pulled straight from
  // the steps above — never invented.
  const filesWritten = (scaffold?.filesWritten ?? []).map((f) => f.path);
  const terminalStatus =
    documentation && verifyPassed
      ? "built"
      : scaffold && verifyFailed
        ? "verify-failed"
        : review && approval?.approved === false
          ? "denied"
          : design
            ? "designed"
            : "incomplete";
  const terminalSummary =
    documentation?.summary ??
    scaffold?.summary ??
    design?.summary ??
    clarify?.goal ??
    `Workflow "${workflowName}".`;

  return (
    <Workflow name="create-workflow">
      <Sequence>
        {/* 1 — Turn the freeform ask into a structured, buildable spec. */}
        <Task id="clarify" output={outputs.clarify} agent={agents.smart}>
          <ClarifyPrompt
            request={ctx.input.prompt ?? "Describe the workflow you want to build, in plain English."}
            name={ctx.input.name}
          />
        </Task>

        {/* 2 — Docs & skills: decide and ACTUALLY install/gather what the new
            workflow and its worker agents need before we design anything. */}
        {clarify ? (
          <Task
            id="provision"
            output={outputs.provision}
            agent={agents.implement}
            heartbeatTimeoutMs={600_000}
          >
            <ProvisionPrompt spec={clarify} skillsDir={SKILLS_DIR} workflowsDir={WORKFLOWS_DIR} />
          </Task>
        ) : null}

        {/* 3 — Design the concrete workflow graph from spec + provisioning. */}
        {provision ? (
          <Task id="design" output={outputs.design} agent={agents.smart}>
            <DesignPrompt
              spec={clarify}
              provisioning={provision}
              workflowsDir={WORKFLOWS_DIR}
              promptsDir={PROMPTS_DIR}
              uiDir={UI_DIR}
            />
          </Task>
        ) : null}

        {/* 4 — Optional durable human approval of the design before writing files. */}
        <Branch
          if={review && designed}
          then={
            <Approval
              id="approve-design"
              output={outputs.approval}
              request={{
                title: `Approve design for "${workflowName}"`,
                summary: [
                  design?.summary ?? "Review the proposed workflow design before scaffolding.",
                  ...(clarify?.clarifyingQuestions ?? []).map(
                    (q, i) => `Q${i + 1}: ${q.question} (assumed: ${q.assumption})`,
                  ),
                ].join("\n"),
              }}
            />
          }
          else={null}
        />

        {/* 5 — Scaffold the real files (workflow .tsx + prompts). */}
        {proceed ? (
          <Task
            id="scaffold"
            output={outputs.scaffold}
            agent={agents.implement}
            heartbeatTimeoutMs={900_000}
          >
            <ScaffoldPrompt
              design={design}
              provisioning={provision}
              workflowsDir={WORKFLOWS_DIR}
              promptsDir={PROMPTS_DIR}
              uiDir={UI_DIR}
            />
          </Task>
        ) : null}

        {/* 6 — Verify the graph renders; fix-and-retry until it compiles cleanly. */}
        {proceed && scaffold ? (
          <Loop id="verify:loop" until={verifyPassed} maxIterations={3} onMaxReached="return-last">
            <Sequence>
              <Task id="verify" output={outputs.verify}>
                {async () => {
                  const errors: string[] = [];
                  const graphCmd = `bunx smithers-orchestrator graph ${workflowFile}`;
                  const res = await $`bunx smithers-orchestrator graph ${workflowFile}`.nothrow().quiet();
                  if (res.exitCode !== 0) {
                    const errText = `${res.stderr?.toString() ?? ""}\n${res.stdout?.toString() ?? ""}`.trim();
                    errors.push(`[graph] ${errText.slice(0, 6000)}`);
                  }
                  // If a custom UI was scaffolded, it must at least transpile.
                  const uiExists = await Bun.file(uiFile).exists();
                  let command = graphCmd;
                  if (uiExists) {
                    command = `${graphCmd} && bun build --no-bundle ${uiFile}`;
                    const uiRes = await $`bun build --no-bundle ${uiFile}`.nothrow().quiet();
                    if (uiRes.exitCode !== 0) {
                      const uiErr = `${uiRes.stderr?.toString() ?? ""}\n${uiRes.stdout?.toString() ?? ""}`.trim();
                      errors.push(`[ui] ${uiFile}: ${uiErr.slice(0, 6000)}`);
                    }
                  }
                  const passed = errors.length === 0;
                  return {
                    passed,
                    command,
                    errors,
                    notes: passed
                      ? `${workflowName} loads, its graph renders without executing${uiExists ? `, and ${uiFile} transpiles` : ""}.`
                      : `verification failed for ${workflowName}; see errors.`,
                  };
                }}
              </Task>

              <Branch
                if={verifyFailed}
                then={
                  <Task
                    id="fix"
                    output={outputs.scaffold}
                    agent={agents.implement}
                    heartbeatTimeoutMs={900_000}
                  >
                    <FixPrompt
                      workflowName={workflowName}
                      workflowFile={workflowFile}
                      errors={lastVerify?.errors ?? []}
                      design={design}
                      workflowsDir={WORKFLOWS_DIR}
                      promptsDir={PROMPTS_DIR}
                      uiDir={UI_DIR}
                      uiFile={uiFile}
                    />
                  </Task>
                }
                else={null}
              />
            </Sequence>
          </Loop>
        ) : null}

        {/* 7 — Document the new workflow so future agents know how to run it. */}
        {proceed && verifyPassed ? (
          <Task id="document" output={outputs.document} agent={agents.cheapFast}>
            <DocumentPrompt
              workflowName={workflowName}
              design={design}
              skillsDir={SKILLS_DIR}
              workflowFile={workflowFile}
              uiFile={uiFile}
            />
          </Task>
        ) : null}

        {/* 8 — Terminal summary: aggregate the useful results so the run prints
            something meaningful. Runs last in the sequence on every exit path. */}
        {clarify ? (
          <Task id="output" output={outputs.output}>
            {() => {
              const uiWritten = filesWritten.includes(uiFile);
              const nextSteps =
                terminalStatus === "built"
                  ? [
                      `smithers workflow run ${workflowName} --prompt "<your input>"  # or: smithers up ${workflowFile}`,
                      `bunx smithers-orchestrator graph ${workflowFile}  # print the graph; add --interactive for the TUI`,
                      ...(uiWritten ? [`smithers ui <runId>  # open the custom UI in ${uiFile} for a run`] : []),
                      `smithers workflow run create-workflow --prompt "iterate on ${workflowName}: <what to change>"  # iterate`,
                    ]
                  : [
                      `smithers inspect <runId>  # review why the run stopped at status "${terminalStatus}"`,
                      `smithers workflow run create-workflow --prompt "retry building ${workflowName}"`,
                    ];
              return {
                workflow: workflowName,
                workflowFile,
                status: terminalStatus,
                summary: terminalSummary,
                filesWritten,
                fileCount: filesWritten.length,
                verified: verifyPassed,
                skillPath: documentation?.skillPath ?? null,
                uiFile: uiWritten ? uiFile : null,
                nextSteps,
              };
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
