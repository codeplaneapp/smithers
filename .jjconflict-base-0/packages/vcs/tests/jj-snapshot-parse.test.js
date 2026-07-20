import { describe, expect, test } from "bun:test";
import { parseWorkspaceSnapshot } from "../src/jj.js";

describe("parseWorkspaceSnapshot", () => {
	test("uses an empty change id fallback when jj omits change_id", () => {
		expect(parseWorkspaceSnapshot("commit-1\n", "op-1\n")).toEqual({
			commitId: "commit-1",
			changeId: "",
			operationId: "op-1",
		});
	});

	test("uses the first non-empty operation id line", () => {
		expect(parseWorkspaceSnapshot("commit-1\nchange-1\n", "\n  op-1  \n")).toEqual({
			commitId: "commit-1",
			changeId: "change-1",
			operationId: "op-1",
		});
	});

	test("returns null when commit id or operation id is missing", () => {
		expect(parseWorkspaceSnapshot("\nchange-1\n", "op-1\n")).toBeNull();
		expect(parseWorkspaceSnapshot("commit-1\nchange-1\n", "\n")).toBeNull();
	});
});
