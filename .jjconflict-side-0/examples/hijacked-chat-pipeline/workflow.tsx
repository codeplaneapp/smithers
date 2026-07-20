// smithers-source: example
// smithers-display-name: Hijacked Chat Pipeline
/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { UI } from "@smithers-orchestrator/components";
import { CodexAgent } from "@smithers-orchestrator/agents/CodexAgent";
import { z } from "zod/v4";

const inputSchema = z.object({
  goal: z.string().optional(),
});

const scopeOutput = z.object({});
const planOutput = z.object({});
const deliverOutput = z.object({});

const codex = new CodexAgent({
  model: "gpt-5.6-luna",
  config: { model_reasoning_effort: "medium" },
  skipGitRepoCheck: true,
});

const { Workflow, Task, Sequence, smithers } = createSmithers({
  input: inputSchema,
  hijackedChatScope: scopeOutput,
  hijackedChatPlan: planOutput,
  hijackedChatDeliver: deliverOutput,
});

export default smithers((ctx) => {
  const goal = ctx.input.goal?.trim() || "Inspect this repository and make one small, useful improvement.";
  const artifactDir = `.smithers/executions/${ctx.runId}/hijacked-chat-pipeline`;

  return (
    <Workflow name="hijacked-chat-pipeline">
      <UI entry="./ui.tsx" title="Hijacked Chat Pipeline" />
      <Sequence>
        <Task
          id="scope"
          label="Scope"
          output={scopeOutput}
          agent={codex}
          hijack
          onHijackExit="complete"
          noRetry
        >
          {`You are the scoping partner in an interactive three-stage pipeline.

User goal: ${goal}

Collaborate with the user in this hijacked session. Inspect the repository as needed, clarify intent, constraints, and acceptance criteria, but do not implement the change. Once you and the user agree, create ${artifactDir}/brief.md with a concise durable brief for the next stage.

When this stage is complete, return ONLY the raw JSON object {} with no prose or code fence. The user will then return control to Smithers from the chat UI.`}
        </Task>
        <Task
          id="plan"
          label="Plan"
          output={planOutput}
          agent={codex}
          hijack
          onHijackExit="complete"
          noRetry
        >
          {`You are the planning partner in an interactive three-stage pipeline.

User goal: ${goal}

Read ${artifactDir}/brief.md first. Collaborate with the user to turn that brief into a concrete implementation and verification plan. Inspect the repository where needed, but do not implement product changes in this stage. Once the plan is agreed, write it to ${artifactDir}/plan.md for the delivery stage.

When this stage is complete, return ONLY the raw JSON object {} with no prose or code fence. The user will then return control to Smithers from the chat UI.`}
        </Task>
        <Task
          id="deliver"
          label="Deliver"
          output={deliverOutput}
          agent={codex}
          hijack
          onHijackExit="complete"
          noRetry
        >
          {`You are the delivery partner in an interactive three-stage pipeline.

User goal: ${goal}

Read ${artifactDir}/brief.md and ${artifactDir}/plan.md first. Collaborate with the user while you implement the agreed change in the real workspace. Preserve unrelated work, run proportionate verification, and record a short completion note with tests and remaining caveats in ${artifactDir}/receipt.md.

When the work is genuinely complete, return ONLY the raw JSON object {} with no prose or code fence. The user will then return control to Smithers from the chat UI.`}
        </Task>
      </Sequence>
    </Workflow>
  );
});
