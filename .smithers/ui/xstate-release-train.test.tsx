import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider, type NodeProps } from "@xyflow/react";
import { SmithersTaskNode, type SmithersFlowNode } from "smithers-orchestrator/gateway-ui";
import { releaseTrainGraphSpec } from "./xstate-release-train";

describe("XState release train UI", () => {
	const spec = releaseTrainGraphSpec({ value: "drafting", context: { revision: 1 } }, new Set(["researching", "awaitingApproval"]));

	test("draws every state in the chart", () => {
		expect(spec.map((node) => node.id)).toEqual(["researching", "awaitingApproval", "drafting", "waitingForRevision", "done"]);
	});

	test("separates the active state from visited and unreached ones", () => {
		const byId = Object.fromEntries(spec.map((node) => [node.id, node.status]));
		expect(byId.drafting).toBe("running");
		expect(byId.researching).toBe("done");
		expect(byId.awaitingApproval).toBe("done");
		expect(byId.waitingForRevision).toBe("pending");
		expect(byId.done).toBe("pending");
	});

	test("carries the transition edges that target each state", () => {
		const drafting = spec.find((node) => node.id === "drafting");
		expect(drafting?.dependsOn).toEqual(["awaitingApproval", "waitingForRevision"]);
	});

	test("renders the active state node", () => {
		const active = spec.find((node) => node.id === "drafting")!;
		// SmithersTaskNode only reads `data`; the rest of NodeProps is irrelevant here.
		const nodeProps = {
			data: { label: active.label, kind: active.kind, output: active.output ?? "", status: active.status },
		} as unknown as NodeProps<SmithersFlowNode>;
		const html = renderToStaticMarkup(
			<ReactFlowProvider>
				<SmithersTaskNode {...nodeProps} />
			</ReactFlowProvider>,
		);
		expect(html).toContain("drafting");
		expect(html).toContain('data-status="running"');
		expect(html).toContain("CURRENT");
	});
});
