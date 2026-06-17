import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const root = resolve(import.meta.dir, "../../..");
const sourceTypes = readFileSync(resolve(root, "packages/graph/src/types.ts"), "utf8");
const publishedTypes = readFileSync(resolve(root, "packages/graph/src/index.d.ts"), "utf8");

function extractTypeBody(source, typeName) {
	const match = source.match(new RegExp(`type ${typeName} = \\{([\\s\\S]*?)\\n\\};`));
	if (!match) throw new Error(`Could not find ${typeName}`);
	return match[1];
}

describe("published TaskDescriptor declarations", () => {
	test("include the forkSource field from the source TaskDescriptor type", () => {
		const sourceTaskDescriptor = extractTypeBody(sourceTypes, "TaskDescriptor");
		const publishedTaskDescriptor = extractTypeBody(publishedTypes, "TaskDescriptor\\$1");

		expect(sourceTaskDescriptor).toContain("forkSource?: string;");
		expect(publishedTaskDescriptor).toContain("forkSource?: string;");
		expect(publishedTaskDescriptor.indexOf("needs?: Record<string, string>;")).toBeLessThan(
			publishedTaskDescriptor.indexOf("forkSource?: string;"),
		);
		expect(publishedTaskDescriptor.indexOf("forkSource?: string;")).toBeLessThan(
			publishedTaskDescriptor.indexOf("worktreeId?: string;"),
		);
	});
});
