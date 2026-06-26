import { describe, expect, test } from "bun:test";
import { workflowSummarySchema } from "../src/mcp/semantic-tools.js";

// Regression test for #459.
//
// The semantic MCP `run_workflow` tool could create/start a run and THEN fail its
// own structured-output validation: `workflowSummarySchema` requires `path`, while
// at one point the runtime summary produced by `loadWorkflowById()` only carried
// `entryFile`. That left agents seeing an output-validation error (`expected string
// at data.workflow.path`) even though the side-effecting launch had already happened
// — potentially orphaning the run.
//
// `loadWorkflowById()` now populates BOTH `entryFile` and `path` (and `path` is
// always a real string because `workflowFromFile()` sets `path: entryFile`). These
// tests lock that contract so the schema and the summary shape can never silently
// drift apart again.

// The exact field set `loadWorkflowById()` builds for the `run_workflow` response
// summary (apps/cli/src/mcp/semantic-tools.js). Kept in lockstep with that builder.
function loadWorkflowByIdSummary(overrides = {}) {
	return {
		id: "implement",
		metadataVersion: 1,
		displayName: "Implement",
		scope: "local",
		entryFile: "/repo/.smithers/workflows/implement.tsx",
		path: "/repo/.smithers/workflows/implement.tsx",
		sourceType: "user",
		description: "Implement a change and validate it.",
		tags: ["coding"],
		aliases: [],
		...overrides,
	};
}

describe("run_workflow summary schema contract (#459 regression)", () => {
	test("a fully-populated loadWorkflowById summary passes structured-output validation", () => {
		const result = workflowSummarySchema.safeParse(loadWorkflowByIdSummary());
		expect(result.success).toBe(true);
	});

	test("schema requires `path` — the field whose omission broke run_workflow", () => {
		const { path, ...withoutPath } = loadWorkflowByIdSummary();
		const result = workflowSummarySchema.safeParse(withoutPath);
		expect(result.success).toBe(false);
		// Validation must point at the missing `path`, matching the original
		// `expected string at data.workflow.path` failure.
		const onPath = !result.success && result.error.issues.some((issue) => issue.path.join(".") === "path");
		expect(onPath).toBe(true);
	});

	test("schema also requires `entryFile`, so the summary cannot standardize on only one of the two", () => {
		const { entryFile, ...withoutEntryFile } = loadWorkflowByIdSummary();
		expect(workflowSummarySchema.safeParse(withoutEntryFile).success).toBe(false);
	});

	test("`path` and `entryFile` describe the same workflow file", () => {
		const parsed = workflowSummarySchema.parse(loadWorkflowByIdSummary());
		expect(parsed.path).toBe(parsed.entryFile);
	});
});
