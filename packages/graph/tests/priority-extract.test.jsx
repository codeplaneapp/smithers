import { describe, expect, test } from "bun:test";
import { extractGraph } from "../src/extract.js";
import { extractFromHost } from "../src/dom/extract.js";
import { MERGE_QUEUE_PRIORITY } from "../src/constants.js";

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

/**
 * @param {string} id
 * @param {Record<string, any>} [extra]
 */
function taskEl(id, extra = {}) {
	return hostEl("smithers:task", { id, output: "t", ...extra });
}

/** @param {ReturnType<typeof extractGraph>} res */
function byId(res) {
	return new Map(res.tasks.map((task) => [task.nodeId, task]));
}

const extractors = [
	["extractGraph", extractGraph],
	["extractFromHost", extractFromHost],
];

describe.each(extractors)("%s: priority extraction", (_name, extract) => {
	test("explicit priority prop lands on the task descriptor; unset stays undefined", () => {
		const root = hostEl("smithers:workflow", {}, [
			taskEl("plain"),
			taskEl("hot", { priority: 7 }),
			taskEl("cold", { priority: -3 }),
			taskEl("mdx", { priority: "12" }),
			taskEl("bogus", { priority: "not-a-number" }),
		]);
		const tasks = byId(extract(root));
		expect(tasks.get("plain")?.priority).toBeUndefined();
		expect(tasks.get("hot")?.priority).toBe(7);
		expect(tasks.get("cold")?.priority).toBe(-3);
		// Numeric strings coerce in line with maxConcurrency; garbage is ignored.
		expect(tasks.get("mdx")?.priority).toBe(12);
		expect(tasks.get("bogus")?.priority).toBeUndefined();
	});
	test("parallel priority is inherited by descendant tasks; explicit child wins", () => {
		const root = hostEl("smithers:workflow", {}, [
			hostEl("smithers:parallel", { id: "grp", priority: 5 }, [
				taskEl("inherits"),
				taskEl("overrides", { priority: 9 }),
				hostEl("smithers:sequence", {}, [taskEl("deep")]),
			]),
			taskEl("outside"),
		]);
		const tasks = byId(extract(root));
		expect(tasks.get("inherits")?.priority).toBe(5);
		expect(tasks.get("overrides")?.priority).toBe(9);
		expect(tasks.get("deep")?.priority).toBe(5);
		expect(tasks.get("outside")?.priority).toBeUndefined();
	});
	test("merge-queue defaults descendants to MERGE_QUEUE_PRIORITY", () => {
		const root = hostEl("smithers:workflow", {}, [
			hostEl("smithers:merge-queue", { id: "queue" }, [
				taskEl("land-1"),
				taskEl("land-2", { priority: 3 }),
			]),
		]);
		const tasks = byId(extract(root));
		expect(tasks.get("land-1")?.priority).toBe(MERGE_QUEUE_PRIORITY);
		expect(tasks.get("land-2")?.priority).toBe(3);
	});
	test("explicit merge-queue priority replaces the default for the subtree", () => {
		const root = hostEl("smithers:workflow", {}, [
			hostEl("smithers:parallel", { id: "outer", priority: 2 }, [
				hostEl("smithers:merge-queue", { id: "queue", priority: 40 }, [taskEl("land")]),
				taskEl("ticket"),
			]),
		]);
		const tasks = byId(extract(root));
		expect(tasks.get("land")?.priority).toBe(40);
		expect(tasks.get("ticket")?.priority).toBe(2);
	});
	test("a merge-queue nested under a prioritized parallel still defaults to MERGE_QUEUE_PRIORITY", () => {
		const root = hostEl("smithers:workflow", {}, [
			hostEl("smithers:parallel", { id: "outer", priority: 5 }, [
				hostEl("smithers:merge-queue", { id: "queue" }, [taskEl("land")]),
			]),
		]);
		const tasks = byId(extract(root));
		expect(tasks.get("land")?.priority).toBe(MERGE_QUEUE_PRIORITY);
	});
});
