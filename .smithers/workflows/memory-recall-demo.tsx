// smithers-source: user
// smithers-display-name: Memory Recall Demo
/** @jsxImportSource smithers-orchestrator */
import { Memory, Task, UI, createSmithers, smithers } from "smithers-orchestrator";
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

const { Workflow: WorkflowRoot, outputs, smithers, useCtx } = createSmithers({
	input: inputSchema,
	triage: triageSchema,
	investigation: investigationSchema,
	response: responseSchema,
});

const bank = "support-triage-demo";
const tags = ["source:run", "scope:main", "branch:main", "stream:release-demo"];

function MemoryRecallDemo() {
	const ctx = useCtx();
	const triagePrompt = [
		`Triage this repeated support incident for ${bank}.`,
		`Account: ${ctx.input.account}.`,
		`Ticket: ${ctx.input.ticket}.`,
		`Severity: ${ctx.input.severity}.`,
		"Use recalled runbook knowledge when it exists.",
		"Return the likely cause, known facts, and the next checks for an on-call engineer.",
	].join(" ");
	const investigationPrompt = [
		`Investigate the triage result for ${ctx.input.account}.`,
		"Check the repeated invoice symptom against durable support knowledge.",
		"Return verified findings, the cause, and a safe recommendation.",
		"Do not retain this investigation automatically because it is an intermediate check.",
	].join(" ");
	const responsePrompt = [
		`Write a customer-ready response for ${ctx.input.account}'s support ticket.`,
		"Use the completed investigation in this run, but demonstrate the opt-out:",
		"do not recall or retain cross-run memory and do not use memory tools.",
		"Include a subject, concise body, and internal note.",
	].join(" ");

	return (
		<WorkflowRoot name="memory-recall-demo">
			<UI entry="../ui/memory-recall-demo.tsx" title="Memory Recall" />
			<Memory
				bank={bank}
				tags={tags}
				recall="auto"
				budget="low"
				maxTokens={1200}
				primers={["support-triage-primer"]}
				retain="on-complete"
				tools
			>
				<Task id="triage" output={outputs.triage} agent={agents.cheapFast} timeoutMs={120_000}>
					{triagePrompt}
				</Task>

				{ctx.outputMaybe(outputs.triage, { nodeId: "triage" }) ? (
					<Task
						id="investigation"
						output={outputs.investigation}
						agent={agents.cheapFast}
						timeoutMs={120_000}
						memory={{
							bank,
							tags,
							recall: "duplicate invoice retry idempotency history",
							budget: "low",
							maxTokens: 1200,
							primers: ["support-triage-primer"],
							retain: "off",
							tools: true,
						}}
					>
						{investigationPrompt}
					</Task>
				) : null}

				{ctx.outputMaybe(outputs.investigation, { nodeId: "investigation" }) ? (
					<Task
						id="customer-response"
						output={outputs.response}
						agent={agents.cheapFast}
						timeoutMs={120_000}
						memory={{
							bank,
							tags,
							recall: false,
							retain: "off",
							tools: false,
						}}
					>
						{responsePrompt}
					</Task>
				) : null}
			</Memory>
		</WorkflowRoot>
	);
}

export default smithers(() => <MemoryRecallDemo />);
