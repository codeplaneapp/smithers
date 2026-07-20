/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LifecycleCard, deriveMemoryLifecycle } from "./memory-recall-demo";

describe("Memory Recall UI", () => {
	test("shows recalled blocks, memory tools, and a retained digest from gateway data", () => {
		const rows = deriveMemoryLifecycle(
			[
				{ id: "triage", status: "ok", toolCalls: [{ name: "recall" }, { name: "remember" }] },
			],
			[{ event: "MemoryRecalled", payload: { nodeId: "triage", text: "Known duplicate invoice pattern", tokens: 14 } }],
			[{ valueJson: JSON.stringify({ content: "Task triage completed successfully.\n\nFindings" }) }],
		);
		const triage = rows.find((row) => row.nodeId === "triage")!;
		expect(triage.recalled).toEqual(["Known duplicate invoice pattern"]);
		expect(triage.recallTokens).toBe(14);
		expect(triage.toolCalls).toEqual(["recall", "remember"]);
		expect(triage.digest).toContain("Task triage completed successfully.");
		const html = renderToStaticMarkup(<LifecycleCard row={triage} />);
		expect(html).toContain("Known duplicate invoice pattern");
		expect(html).toContain("Task triage completed successfully.");
	});

	test("does not invent lifecycle data when gateway data is empty", () => {
		const rows = deriveMemoryLifecycle([], [], []);
		const response = rows.find((row) => row.nodeId === "customer-response")!;
		expect(response.recalled).toEqual([]);
		expect(response.toolCalls).toEqual([]);
		expect(response.digest).toBeUndefined();
		expect(response.config.recall).toBe(false);
		expect(response.config.retain).toBe("off");
		const html = renderToStaticMarkup(<LifecycleCard row={response} />);
		expect(html).toContain("No recalled block is exposed by the gateway.");
		expect(html).toContain("Retention is disabled for this task.");
	});
});
