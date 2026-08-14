// smithers-source: user
// smithers-display-name: Memory Recall Demo
/** @jsxImportSource smthrs */
import { Memory, Task, UI, createSmithers } from "smthrs";
import { z } from "zod/v4";
import { agents } from "../agents";

const inputSchema = z.object({
  account: z.string().default("Northstar Health"),
  ticket: z.string().default("Users see duplicate invoices after a retry").describe("The incoming support ticket."),
  severity: z.enum(["low", "medium", "high"]).default("high"),
});

const triageSchema = z.object({
  classification: z.string(),
  likelyCause: z.string(),
  knownFacts: z.array(z.string()),
  nextChecks: z.array(z.string()),
});

const investigationSchema = z.object({
  findings: z.array(z.string()),
  verifiedCause: z.string(),
  recommendedFix: z.string(),
});

const responseSchema = z.object({
  subject: z.string(),
  body: z.string(),
  internalNote: z.string(),
});

const {
  Workflow: WorkflowRoot,
  outputs,
  smithers,
  useCtx,
} = createSmithers({
  input: inputSchema,
  triage: triageSchema,
  investigation: investigationSchema,
  response: responseSchema,
});

export const MEMORY_BANK = "support-triage-demo";
export const MEMORY_TAGS = ["source:run", "scope:main", "branch:main", "stream:release-demo"];

export const INHERITED_MEMORY = {
  bank: MEMORY_BANK,
  tags: MEMORY_TAGS,
  recall: "auto" as const,
  budget: "low" as const,
  maxTokens: 1200,
  primers: ["support-triage-primer"],
  retain: "on-complete" as const,
  tools: true,
};

export const INVESTIGATION_MEMORY = {
  ...INHERITED_MEMORY,
  recall: "duplicate invoice retry idempotency history",
  retain: "off" as const,
};

export const RESPONSE_MEMORY = {
  bank: MEMORY_BANK,
  tags: MEMORY_TAGS,
  recall: false as const,
  budget: "mid" as const,
  maxTokens: 2048,
  primers: [],
  retain: "off" as const,
  tools: false,
};

function MemoryRecallDemo() {
  const ctx = useCtx();
  const account = ctx.input.account ?? "Northstar Health";
  const ticket = ctx.input.ticket ?? "Users see duplicate invoices after a retry";
  const severity = ctx.input.severity ?? "high";
  const triagePrompt = [
    `Triage this repeated support incident for ${MEMORY_BANK}.`,
    `Account: ${account}.`,
    `Ticket: ${ticket}.`,
    `Severity: ${severity}.`,
    "Use recalled runbook knowledge when it exists.",
    "Before answering, call the recall tool once for duplicate invoice retry knowledge.",
    "If it returns useful guidance, use it in your triage.",
    "If the recalled guidance is useful, call the remember tool once to save the verified idempotency lesson.",
    "Return the likely cause, known facts, and the next checks for an on-call engineer.",
  ].join(" ");
  const investigationPrompt = [
    `Investigate the triage result for ${account}.`,
    "Check the repeated invoice symptom against durable support knowledge.",
    "Return verified findings, the cause, and a safe recommendation.",
    "Do not retain this investigation automatically because it is an intermediate check.",
  ].join(" ");
  const responsePrompt = [
    `Write a customer-ready response for ${account}'s support ticket.`,
    "Use the completed investigation in this run, but demonstrate the opt-out:",
    "do not recall or retain cross-run memory and do not use memory tools.",
    "Include a subject, concise body, and internal note.",
  ].join(" ");

  return (
    <WorkflowRoot name="memory-recall-demo">
      <UI entry="../ui/memory-recall-demo.tsx" title="Memory Recall" />
      <Memory {...INHERITED_MEMORY}>
        <Task
          id="triage"
          output={outputs.triage}
          agent={agents.cheapFast}
          timeoutMs={120_000}
          meta={{ memoryDemoMode: "inherited" }}
        >
          {triagePrompt}
        </Task>

        {ctx.outputMaybe(outputs.triage, { nodeId: "triage" }) ? (
          <Task
            id="investigation"
            output={outputs.investigation}
            agent={agents.cheapFast}
            timeoutMs={120_000}
            needs={{ triage: "triage" }}
            deps={{ triage: outputs.triage }}
            memory={INVESTIGATION_MEMORY}
            meta={{ memoryDemoMode: "overridden" }}
          >
            {(deps: { triage: z.infer<typeof triageSchema> }) => (
              <>
                {investigationPrompt}
                {"\n\nTriage output from this run:\n"}
                {JSON.stringify(deps.triage)}
              </>
            )}
          </Task>
        ) : null}

        {ctx.outputMaybe(outputs.investigation, { nodeId: "investigation" }) ? (
          <Task
            id="customer-response"
            output={outputs.response}
            agent={agents.cheapFast}
            timeoutMs={120_000}
            needs={{ investigation: "investigation" }}
            deps={{ investigation: outputs.investigation }}
            memory={RESPONSE_MEMORY}
            meta={{ memoryDemoMode: "opted-out" }}
          >
            {(deps: { investigation: z.infer<typeof investigationSchema> }) => (
              <>
                {responsePrompt}
                {"\n\nInvestigation output from this run:\n"}
                {JSON.stringify(deps.investigation)}
              </>
            )}
          </Task>
        ) : null}
      </Memory>
    </WorkflowRoot>
  );
}

export default smithers(() => <MemoryRecallDemo />);
