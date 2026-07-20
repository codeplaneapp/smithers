import { describe, expect, test } from "bun:test";
import { MergeQueue } from "../src/components/MergeQueue.js";
import { Parallel } from "../src/components/Parallel.js";
import { Sequence } from "../src/components/Sequence.js";

describe("failurePolicy container props", () => {
	for (const [name, Component] of [["Parallel", Parallel], ["MergeQueue", MergeQueue], ["Sequence", Sequence]]) {
		test(`${name} forwards failurePolicy and sanitizes unrelated props`, () => {
			const element = Component({ failurePolicy: "quarantine", skipIf: false, children: "child", unknown: "drop" });
			expect(element.props.failurePolicy).toBe("quarantine");
			expect(element.props.unknown).toBeUndefined();
			expect(element.props.children).toBe("child");
		});
	}

	test("omitted failurePolicy remains omitted for graph-level defaulting", () => {
		expect(Parallel({ children: null }).props.failurePolicy).toBeUndefined();
		expect(MergeQueue({ children: null }).props.failurePolicy).toBeUndefined();
		expect(Sequence({ children: null }).props.failurePolicy).toBeUndefined();
	});
});
