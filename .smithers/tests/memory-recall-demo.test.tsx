import { describe, expect, test } from "bun:test";
import { renderWorkflow } from "smithers-orchestrator/testing";
import workflow from "../workflows/memory-recall-demo";

const workflowPath = `${import.meta.dir}/../workflows/memory-recall-demo.tsx`;
const triageOutput = {
	classification: "billing",
	likelyCause: "retry race",
	knownFacts: ["duplicate invoice"],
	nextChecks: ["inspect idempotency key"],
};
const investigationOutput = {
	findings: ["same retry race as prior incidents"],
	verifiedCause: "missing idempotency guard",
	recommendedFix: "deduplicate the retry path",
};

describe("memory recall demo", () => {
	test("renders the inherited triage task with the complete provider config", async () => {
		const frame = await renderWorkflow(workflow, { workflowPath, input: {} });
		expect(frame.tasks.map((task) => task.nodeId)).toEqual(["triage"]);
		expect(frame.tasks[0]?.memoryConfig).toEqual({
			bank: "support-triage-demo",
			tags: ["source:run", "scope:main", "branch:main", "stream:release-demo"],
			recall: "auto",
			budget: "low",
			maxTokens: 1200,
			primers: ["support-triage-primer"],
			retain: "on-complete",
			tools: true,
		});
	});

	test("resolves the fixed-query investigation override", async () => {
		const frame = await renderWorkflow(workflow, {
			workflowPath,
			input: {},
			outputs: { triage: [{ nodeId: "triage", iteration: 0, ...triageOutput }] },
		});
		const task = frame.tasks.find((candidate) => candidate.nodeId === "investigation");
		expect(task).toBeDefined();
		expect(task?.memoryConfig).toMatchObject({ recall: "duplicate invoice retry idempotency history", retain: "off", tools: true });
	});

	test("resolves the response task as a memory opt-out", async () => {
		const frame = await renderWorkflow(workflow, {
			workflowPath,
			input: {},
			outputs: {
				triage: [{ nodeId: "triage", iteration: 0, ...triageOutput }],
				investigation: [{ nodeId: "investigation", iteration: 0, ...investigationOutput }],
			},
		});
		const task = frame.tasks.find((candidate) => candidate.nodeId === "customer-response");
		expect(task).toBeDefined();
		expect(task?.memoryConfig).toEqual({
			bank: "support-triage-demo",
			tags: ["source:run", "scope:main", "branch:main", "stream:release-demo"],
			recall: false,
			budget: "mid",
			maxTokens: 2048,
			primers: [],
			retain: "off",
			tools: false,
		});
	});
});
