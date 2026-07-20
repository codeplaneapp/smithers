import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import {
	LifecycleCard,
	deriveMemoryLifecycle,
	MemoryLifecycle,
} from "./memory-recall-demo";

describe("Memory Recall UI", () => {
	test("renders attributable recall, tool calls, config, and local digest", () => {
		const rows = deriveMemoryLifecycle(
			[
				{
					id: "triage",
					name: "Triage",
					status: "ok",
					meta: JSON.stringify({
						memoryConfig: {
							bank: "support-triage-demo",
							recall: "auto",
							retain: "on-complete",
							tags: ["branch:main"],
							budget: "low",
							maxTokens: 1200,
							primers: ["support-triage-primer"],
							tools: true,
						},
					}),
					toolCalls: [
						{ toolName: "recall" },
						{ toolName: "remember" },
					],
				},
			],
			[
				{
					event: "MemoryRecalled",
					seq: 1,
					payload: {
						nodeId: "triage",
						query: "invoice retry",
						memories: ["Preserve the idempotency key."],
						primers: ["support-triage-primer"],
						tokenCost: 18,
					},
				},
			],
			[
				{
					namespace: "workflow:support-triage-demo",
					key: "memory:smithers-run-run-1",
					valueJson: JSON.stringify({
						content: "Task triage completed successfully.\n\nVerified lesson",
					}),
				},
			],
			"run-1",
		);
		const html = renderToStaticMarkup(
			<ReactFlowProvider>
				<LifecycleCard row={rows[0]!} />
			</ReactFlowProvider>,
		);

		expect(rows[0]?.recallQuery).toBe("invoice retry");
		expect(rows[0]?.recalledBlocks).toEqual(["Preserve the idempotency key."]);
		expect(rows[0]?.recallTokenCost).toBe(18);
		expect(rows[0]?.toolCalls).toEqual(["recall", "remember"]);
		expect(rows[0]?.digest).toContain("Verified lesson");
		expect(html).toContain("support-triage-demo");
		expect(html).toContain("Preserve the idempotency key.");
		expect(html).toContain("Verified lesson");
	});

	test("does not attribute an unattributed recall event to every task", () => {
		const rows = deriveMemoryLifecycle(
			[
				{ id: "triage", name: "Triage", status: "running" },
				{ id: "investigation", name: "Investigation", status: "queued" },
			],
			[
				{
					event: "MemoryRecalled",
					seq: 1,
					payload: { query: "unattributed" },
				},
			],
			[],
			"run-1",
		);

		expect(rows.every((row) => row.recallQuery === undefined)).toBe(true);
	});

	test("renders explicit opt-out and unavailable gateway configuration", () => {
		const rows = deriveMemoryLifecycle(
			[{ id: "customer-response", name: "Response", status: "ok" }],
			[],
			[],
		);
		const html = renderToStaticMarkup(
			<ReactFlowProvider>
				<LifecycleCard row={rows[0]!} />
			</ReactFlowProvider>,
		);

		expect(html).toContain("Resolved config not exposed");
		expect(html).toContain("No attributable recall snapshot is exposed");
		expect(html).toContain("No remember or recall calls observed");
	});

	test("renders the application empty state", () => {
		const html = renderToStaticMarkup(
			<ReactFlowProvider>
				<MemoryLifecycle rows={[]} />
			</ReactFlowProvider>,
		);

		expect(html).toContain("No memory tasks yet");
	});
});
