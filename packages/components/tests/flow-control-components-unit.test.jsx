/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import React from "react";
import { z } from "zod";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import { SmithersContext, SmithersCtx } from "@smithers-orchestrator/react-reconciler/context";
import { Poller, Task, WaitForEvent } from "../src/components/index.js";

async function render(element) {
	const renderer = new SmithersRenderer();
	return renderer.render(element);
}

function ctxFor({ iteration = 0, iterations, outputs = {} } = {}) {
	return new SmithersCtx({
		runId: "flow-control-unit",
		iteration,
		iterations,
		input: {},
		outputs,
	});
}

describe("flow control component units", () => {
	test("Task deps defer loudly, then merge explicit and mapped dependencies when resolved", async () => {
		const missingCtx = ctxFor();
		const unresolved = await render(
			<SmithersContext.Provider value={missingCtx}>
				<Task
					id="summary"
					output="summary_out"
					dependsOn={["gate"]}
					needs={{ source: "load-source" }}
					deps={{ source: "source_out" }}
				>
					{({ source }) => ({ message: source.message })}
				</Task>
			</SmithersContext.Provider>,
		);

		expect(unresolved.tasks).toHaveLength(0);
		expect(missingCtx._deferredDeps).toEqual([{ nodeId: "summary", waitingOn: ["load-source"] }]);

		const readyCtx = ctxFor({
			outputs: {
				source_out: [{ runId: "flow-control-unit", nodeId: "load-source", iteration: 0, message: "ready" }],
			},
		});
		const resolved = await render(
			<SmithersContext.Provider value={readyCtx}>
				<Task
					id="summary"
					output="summary_out"
					dependsOn={["gate", "load-source"]}
					needs={{ source: "load-source" }}
					deps={{ source: "source_out" }}
				>
					{({ source }) => ({ message: source.message })}
				</Task>
			</SmithersContext.Provider>,
		);

		expect(readyCtx._deferredDeps).toEqual([]);
		expect(resolved.tasks[0].staticPayload).toEqual({ message: "ready" });
		expect(resolved.tasks[0].dependsOn).toEqual(["gate", "load-source"]);
	});

	test("Poller applies fixed, linear, and exponential backoff from the current loop iteration", async () => {
		const cases = [
			["fixed", 100],
			["linear", 300],
			["exponential", 400],
		];

		for (const [backoff, expectedTimeoutMs] of cases) {
			const graph = await render(
				<SmithersContext.Provider
					value={ctxFor({ iteration: 2, iterations: { "deploy-loop": 2 } })}
				>
					<Poller
						id="deploy"
						check={() => ({ satisfied: false })}
						checkOutput="check_out"
						backoff={backoff}
						intervalMs={100}
						maxAttempts={7}
						onTimeout="return-last"
					/>
				</SmithersContext.Provider>,
			);

			expect(graph.tasks[0].nodeId).toBe("deploy-check");
			expect(graph.tasks[0].timeoutMs).toBe(expectedTimeoutMs);
			expect(graph.xml.props).toMatchObject({
				id: "deploy-loop",
				maxIterations: "7",
				onMaxReached: "return-last",
			});
		}
	});

	test("WaitForEvent carries async timeout, correlation, output schema, and timeout policy", async () => {
		const outputSchema = z.object({ ok: z.boolean(), payload: z.string() });
		const graph = await render(
			<WaitForEvent
				id="wait-ready"
				event="ready"
				correlationId="deploy-42"
				output={outputSchema}
				outputSchema={outputSchema}
				timeoutMs={15_000}
				onTimeout="return-last"
				async
				label="Wait for deploy"
				meta={{ owner: "release" }}
			/>,
		);

		const task = graph.tasks[0];
		expect(task.nodeId).toBe("wait-ready");
		expect(task.outputRef).toBe(outputSchema);
		expect(task.outputSchema).toBe(outputSchema);
		expect(task.waitAsync).toBe(true);
		expect(task.timeoutMs).toBe(15_000);
		expect(task.label).toBe("Wait for deploy");
		expect(task.meta).toMatchObject({
			event: "ready",
			correlationId: "deploy-42",
			onTimeout: "return-last",
			owner: "release",
			__waitForEvent: true,
			__eventName: "ready",
			__correlationId: "deploy-42",
			__onTimeout: "return-last",
		});
	});
});
