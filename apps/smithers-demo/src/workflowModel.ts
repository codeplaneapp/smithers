export type WorkflowKind =
  | "agent"
  | "compute"
  | "approval"
  | "parallel"
  | "merge"
  | "loop"
  | "branch"
  | "sandbox"
  | "worktree"
  | "timer"
  | "signal"
  | "human";

export type WorkflowNodeSpec = {
  id: string;
  label: string;
  kind: WorkflowKind;
  output: string;
  prompt: string;
  dependsOn: string[];
  parallelGroupId?: string;
};

export type WorkflowSpec = {
  name: string;
  description: string;
  inputPrompt: string;
  nodes: WorkflowNodeSpec[];
};

export const SMITHERS_CAPABILITY_PROMPT = `Generate a Smithers workflow that can use the full Smithers capability surface when relevant:
- Task agents with typed Zod outputs, prompts, tool access, retries, timeouts, and structured summaries.
- Sequence for deterministic step order.
- Parallel and merge-queue for concurrent research, implementation, validation, or agent debates.
- Ralph/Loop for iterative implement-review-fix or multi-round debate cycles.
- Branch/decision routing for conditional follow-up work.
- Approval and HumanTask for operator gates, decisions, selections, and final release approval.
- Worktree and Sandbox for isolated code execution, patch validation, and review.
- Scorers/evals for repeatable quality checks and judge tasks.
- Memory recall/remember for durable context across long-running runs.
- Timers, wait-for-event, and signals for async external coordination.
- Saga and try/catch/finally for rollback and cleanup.
- Continue-as-new for long horizon workflows.
- Gateway/devtools observability so operators can inspect active runs.

Return a workflow that makes control flow explicit in the graph and in the generated Smithers React code.`;

const baseNodes: WorkflowNodeSpec[] = [
  {
    id: "intake",
    label: "Intake",
    kind: "agent",
    output: "intake",
    prompt: "Summarize the request, identify constraints, and list missing facts.",
    dependsOn: [],
  },
  {
    id: "plan",
    label: "Plan",
    kind: "agent",
    output: "plan",
    prompt: "Create an implementation plan with risk areas and verification steps.",
    dependsOn: ["intake"],
  },
];

function normalizePrompt(prompt: string) {
  return prompt.trim().replace(/\s+/g, " ");
}

function includesAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return slug || "generated-workflow";
}

function outputSchemaFor(node: WorkflowNodeSpec) {
  if (node.output === "finalResult") {
    return "z.object({ winner: z.string(), reasoning: z.string(), caveats: z.array(z.string()).default([]) })";
  }
  if (node.kind === "approval") {
    return "z.object({ approved: z.boolean(), note: z.string().nullable() })";
  }
  return "z.object({ summary: z.string(), evidence: z.array(z.string()).default([]) })";
}

export function generateWorkflowFromPrompt(prompt: string): WorkflowSpec {
  const normalized = normalizePrompt(prompt);
  const lower = normalized.toLowerCase();

  if (
    includesAny(lower, ["communism", "capitalism"]) &&
    includesAny(lower, ["debate", "judge", "final result"])
  ) {
    return {
      name: "communism-capitalism-debate-loop",
      description: normalized,
      inputPrompt: normalized,
      nodes: [
        {
          id: "debate_loop",
          label: "Debate Loop",
          kind: "loop",
          output: "debateLoop",
          prompt: "Run two debate rounds, carrying the transcript forward each iteration.",
          dependsOn: [],
        },
        {
          id: "capitalism_round_1",
          label: "Capitalism LM R1",
          kind: "agent",
          output: "capitalismRound1",
          prompt: "Argue for capitalism in round 1 and set up concrete claims.",
          dependsOn: ["debate_loop"],
        },
        {
          id: "communism_round_1",
          label: "Communism LM R1",
          kind: "agent",
          output: "communismRound1",
          prompt: "Argue for communism in round 1 and respond to capitalism.",
          dependsOn: ["capitalism_round_1"],
        },
        {
          id: "capitalism_round_2",
          label: "Capitalism LM R2",
          kind: "agent",
          output: "capitalismRound2",
          prompt: "Rebut the communism LM and refine the capitalism case.",
          dependsOn: ["communism_round_1"],
        },
        {
          id: "communism_round_2",
          label: "Communism LM R2",
          kind: "agent",
          output: "communismRound2",
          prompt: "Rebut the capitalism LM and refine the communism case.",
          dependsOn: ["capitalism_round_2"],
        },
        {
          id: "judge_final",
          label: "Judge LM",
          kind: "agent",
          output: "finalResult",
          prompt: "Judge the debate and output the final result with winner, reasoning, and caveats.",
          dependsOn: ["communism_round_2"],
        },
      ],
    };
  }

  const nodes = [...baseNodes];

  const wantsResearch = includesAny(lower, ["research", "discover", "investigate", "audit"]);
  const wantsImplementation = includesAny(lower, ["build", "implement", "fix", "code", "generate"]);
  const wantsDocs = includesAny(lower, ["docs", "documentation", "guide", "readme"]);
  const wantsValidation = includesAny(lower, ["test", "validate", "verify", "qa", "review"]);
  const wantsRelease = includesAny(lower, ["release", "deploy", "ship", "publish"]);
  const wantsSandbox = includesAny(lower, ["sandbox", "isolate", "safe", "untrusted"]);
  const wantsWorktree = includesAny(lower, ["worktree", "branch", "patch", "diff"]);
  const wantsLoop = includesAny(lower, ["loop", "iterate", "retry", "review loop", "until"]);
  const wantsHuman = includesAny(lower, ["human", "operator", "approval", "manual"]);
  const wantsAsync = includesAny(lower, ["timer", "signal", "event", "webhook", "async"]);

  if (wantsWorktree) {
    nodes.push({
      id: "worktree",
      label: "Worktree",
      kind: "worktree",
      output: "worktree",
      prompt: "Create or reuse an isolated worktree for patch generation and review.",
      dependsOn: ["plan"],
    });
  }

  if (wantsResearch) {
    nodes.push({
      id: "research",
      label: "Research",
      kind: "agent",
      output: "research",
      prompt: "Inspect the repository and external context, then produce concrete findings.",
      dependsOn: [wantsWorktree ? "worktree" : "plan"],
      parallelGroupId: "discovery",
    });
  }

  if (wantsLoop) {
    nodes.push({
      id: "iteration_loop",
      label: "Ralph Loop",
      kind: "loop",
      output: "iterationLoop",
      prompt: "Repeat implementation and validation until the scorer and reviewer approve.",
      dependsOn: [wantsResearch ? "research" : wantsWorktree ? "worktree" : "plan"],
    });
  }

  if (wantsImplementation || !wantsDocs) {
    nodes.push({
      id: "implement",
      label: "Implement",
      kind: "agent",
      output: "implementation",
      prompt: "Make the requested code changes and keep the diff scoped.",
      dependsOn: [wantsLoop ? "iteration_loop" : wantsResearch ? "research" : wantsWorktree ? "worktree" : "plan"],
    });
  }

  if (wantsSandbox) {
    nodes.push({
      id: "sandbox_verify",
      label: "Sandbox Verify",
      kind: "sandbox",
      output: "sandboxVerification",
      prompt: "Run generated code or commands inside a sandbox and summarize failures.",
      dependsOn: [nodes.some((node) => node.id === "implement") ? "implement" : "plan"],
    });
  }

  if (wantsDocs) {
    nodes.push({
      id: "document",
      label: "Document",
      kind: "agent",
      output: "documentation",
      prompt: "Write user-facing documentation and a runnable example.",
      dependsOn: [wantsImplementation ? "implement" : "plan"],
      parallelGroupId: wantsValidation ? "quality" : undefined,
    });
  }

  if (wantsValidation || wantsRelease) {
    nodes.push({
      id: "validate",
      label: "Validate",
      kind: "agent",
      output: "validation",
      prompt: "Run tests, type checks, and visual verification. Report failures with fixes.",
      dependsOn: [
        nodes.some((node) => node.id === "sandbox_verify")
          ? "sandbox_verify"
          : nodes.some((node) => node.id === "implement")
            ? "implement"
            : "plan",
      ],
      parallelGroupId: wantsDocs ? "quality" : undefined,
    });
  }

  if (wantsAsync) {
    nodes.push({
      id: "external_signal",
      label: "Wait/Signal",
      kind: "signal",
      output: "externalSignal",
      prompt: "Wait for an external event or timer signal before finalizing.",
      dependsOn: [nodes.at(-1)?.id ?? "plan"],
    });
  }

  if (wantsRelease || wantsHuman) {
    nodes.push({
      id: "approval",
      label: "Approval",
      kind: "approval",
      output: "approval",
      prompt: "Ask a human operator to approve the release candidate.",
      dependsOn: [nodes.some((node) => node.id === "validate") ? "validate" : (nodes.at(-1)?.id ?? "plan")],
    });
  }

  if (wantsRelease) {
    nodes.push({
      id: "release",
      label: "Release",
      kind: "agent",
      output: "release",
      prompt: "Prepare release notes and publish the validated workflow.",
      dependsOn: ["approval"],
    });
  }

  if (!nodes.some((node) => node.id === "validate")) {
    nodes.push({
      id: "review",
      label: "Review",
      kind: "agent",
      output: "review",
      prompt: "Review the generated work for correctness, clarity, and missing tests.",
      dependsOn: [nodes.at(-1)?.id ?? "plan"],
    });
  }

  return {
    name: slugify(normalized),
    description: normalized || "Generate and validate a Smithers workflow.",
    inputPrompt: normalized || "Build a Smithers workflow with implementation and validation.",
    nodes,
  };
}

export function generateSmithersCode(spec: WorkflowSpec) {
  if (spec.name === "communism-capitalism-debate-loop") {
    return generateDebateSmithersCode(spec);
  }

  const outputs = spec.nodes.map((node) => `  ${node.output}: ${outputSchemaFor(node)},`).join("\n");

  const taskCode = spec.nodes
    .map((node) => {
      const needs =
        node.dependsOn.length > 0
          ? ` needs={{ ${node.dependsOn.map((id) => `${id}: "${id}"`).join(", ")} }}`
          : "";
      const approval = node.kind === "approval" ? " needsApproval approvalMode=\"decision\"" : "";
      const meta = ` meta={{ kind: "${node.kind}" }}`;
      return `      <Task id="${node.id}" output={outputs.${node.output}} agent={agent}${needs}${approval}>
        {\`${node.prompt}\n\n${SMITHERS_CAPABILITY_PROMPT}\`}
      </Task>`;
    })
    .join("\n\n");

  return `import { createSmithers, Sequence, Task, Workflow } from "smithers-orchestrator";
import { z } from "zod";

const { smithers, outputs } = createSmithers({
${outputs}
});

export default smithers((ctx) => (
  <Workflow name="${spec.name}">
    {/* ${SMITHERS_CAPABILITY_PROMPT.replaceAll("\n", "\n    ")} */}
    <Sequence>
${taskCode}
    </Sequence>
  </Workflow>
));`;
}

function generateDebateSmithersCode(spec: WorkflowSpec) {
  const outputs = spec.nodes.map((node) => `  ${node.output}: ${outputSchemaFor(node)},`).join("\n");

  return `import { createSmithers, Ralph, Sequence, Task, Workflow } from "smithers-orchestrator";
import { z } from "zod";

const { smithers, outputs } = createSmithers({
${outputs}
});

export default smithers((ctx) => (
  <Workflow name="${spec.name}">
    {/* ${SMITHERS_CAPABILITY_PROMPT.replaceAll("\n", "\n    ")} */}
    <Sequence>
      <Ralph id="debate_loop" maxIterations={2} until={() => false}>
        <Task id="capitalism_round" output={outputs.capitalismRound1} agent={capitalismLm}>
          {\`Argue for capitalism, respond to the prior communism argument, and append evidence to the transcript.

Prompt: ${spec.inputPrompt}\`}
        </Task>

        <Task id="communism_round" output={outputs.communismRound1} agent={communismLm}>
          {\`Argue for communism, respond to the prior capitalism argument, and append evidence to the transcript.

Prompt: ${spec.inputPrompt}\`}
        </Task>
      </Ralph>

      <Task
        id="judge_final"
        output={outputs.finalResult}
        agent={judgeLm}
        needs={{ debate: "debate_loop" }}
      >
        {\`Evaluate the two-LM debate fairly and output the final result with winner, reasoning, and caveats.\`}
      </Task>
    </Sequence>
  </Workflow>
));`;
}
