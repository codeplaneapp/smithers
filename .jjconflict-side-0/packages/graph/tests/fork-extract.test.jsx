import { describe, expect, test } from "bun:test";
import { extractGraph } from "../src/extract.js";

/**
 * @param {string} tag
 * @param {Record<string, any>} [rawProps]
 * @param {any[]} [children]
 */
function hostEl(tag, rawProps = {}, children = []) {
	const stringProps = {};
	for (const [k, v] of Object.entries(rawProps)) {
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
			stringProps[k] = String(v);
		}
	}
	return { kind: "element", tag, props: stringProps, rawProps, children };
}

const fakeAgent = { id: "fake", generate: async () => ({ output: {} }) };

/**
 * @param {string} id
 * @param {Record<string, any>} [extra]
 */
function agentTask(id, extra = {}) {
	return hostEl(
		"smithers:task",
		{ id, output: `${id}_table`, agent: fakeAgent, __smithersKind: "agent", ...extra },
		[hostText(`prompt ${id}`)],
	);
}

/** @param {string} text */
function hostText(text) {
	return { kind: "text", text };
}

describe("extractGraph fork", () => {
	test("records forkSource on the task descriptor", async () => {
		const root = hostEl("smithers:workflow", {}, [
			agentTask("a"),
			agentTask("b", { fork: "a" }),
		]);
		const graph = await extractGraph(root);
		const b = graph.tasks.find((t) => t.nodeId === "b");
		expect(b?.forkSource).toBe("a");
		const a = graph.tasks.find((t) => t.nodeId === "a");
		expect(a?.forkSource).toBeUndefined();
	});

	test("missing fork source throws TASK_FORK_SOURCE_NOT_FOUND", async () => {
		const root = hostEl("smithers:workflow", {}, [
			agentTask("b", { fork: "missing" }),
		]);
		let error;
		try {
			await extractGraph(root);
		} catch (err) {
			error = err;
		}
		expect(error?.code).toBe("TASK_FORK_SOURCE_NOT_FOUND");
		expect(error?.details?.forkSource).toBe("missing");
	});

	test("direct self-fork throws TASK_FORK_CYCLE", async () => {
		const root = hostEl("smithers:workflow", {}, [agentTask("a", { fork: "a" })]);
		let error;
		try {
			await extractGraph(root);
		} catch (err) {
			error = err;
		}
		expect(error?.code).toBe("TASK_FORK_CYCLE");
	});

	test("indirect fork cycle throws TASK_FORK_CYCLE", async () => {
		// a forks b, b forks a → cycle.
		const root = hostEl("smithers:workflow", {}, [
			agentTask("a", { fork: "b" }),
			agentTask("b", { fork: "a" }),
		]);
		let error;
		try {
			await extractGraph(root);
		} catch (err) {
			error = err;
		}
		expect(error?.code).toBe("TASK_FORK_CYCLE");
	});

	test("non-agent forking task throws TASK_FORK_SESSION_UNAVAILABLE", async () => {
		const root = hostEl("smithers:workflow", {}, [
			agentTask("a"),
			hostEl(
				"smithers:task",
				{ id: "b", output: "b_table", fork: "a", __smithersKind: "static", __smithersPayload: { v: 1 } },
				[],
			),
		]);
		let error;
		try {
			await extractGraph(root);
		} catch (err) {
			error = err;
		}
		expect(error?.code).toBe("TASK_FORK_SESSION_UNAVAILABLE");
	});

	test("fork composes with explicit dependsOn without error", async () => {
		const root = hostEl("smithers:workflow", {}, [
			agentTask("a"),
			agentTask("gate"),
			agentTask("b", { fork: "a", dependsOn: ["gate"] }),
		]);
		const graph = await extractGraph(root);
		const b = graph.tasks.find((t) => t.nodeId === "b");
		expect(b?.forkSource).toBe("a");
		expect(b?.dependsOn).toContain("gate");
	});
});
