import { expect, test } from "bun:test";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * Behavioral contract for the path an agent walks when a human says
 * "create a Smithers workflow": scaffold a workflow file, render its graph to
 * prove it loads, then discover/inspect it. This is the deterministic,
 * no-API-key floor under the LLM eval in evals/suites/authoring-workflow-creation
 * — if these CLI verbs don't work, the agent cannot succeed no matter how good
 * the skill prose is.
 */

test("smithers workflow create scaffolds a renderable workflow that discovery can see", () => {
    const repo = createTempRepo();

    const created = runSmithers(["workflow", "create", "agent-made"], {
        cwd: repo.dir,
        format: "json",
    });
    expect(created.exitCode).toBe(0);
    expect(repo.exists(".smithers/workflows/agent-made.tsx")).toBe(true);

    const source = repo.read(".smithers/workflows/agent-made.tsx");
    expect(source).toContain('@jsxImportSource smithers-orchestrator');
    expect(source).toContain('<Workflow name="agent-made"');
    expect(created.json).toMatchObject({ id: "agent-made" });

    // The graph must render without executing — exit 0 is the agent's own
    // "did I write a valid workflow?" check (the create-workflow workflow uses
    // exactly this as its verify gate).
    const graph = runSmithers(["graph", ".smithers/workflows/agent-made.tsx"], {
        cwd: repo.dir,
        format: "json",
    });
    expect(graph.exitCode).toBe(0);
    expect(JSON.stringify(graph.json)).toContain("agent-made");

    // Discovery + inspect must surface the freshly authored workflow.
    const list = runSmithers(["workflow", "list"], { cwd: repo.dir, format: "json" });
    expect(list.exitCode).toBe(0);
    expect(JSON.stringify(list.json)).toContain("agent-made");

    const inspect = runSmithers(["workflow", "inspect", "agent-made"], {
        cwd: repo.dir,
        format: "json",
    });
    expect(inspect.exitCode).toBe(0);
    expect(inspect.json.workflow).toMatchObject({
        id: "agent-made",
        sourceType: "generated",
    });
}, 30_000);

test("smithers workflow create rejects an invalid workflow id before writing", () => {
    const repo = createTempRepo();
    const created = runSmithers(["workflow", "create", "Not A Valid Id"], {
        cwd: repo.dir,
        format: "json",
    });
    expect(created.exitCode).not.toBe(0);
    expect(repo.exists(".smithers/workflows/Not A Valid Id.tsx")).toBe(false);
});

test("smithers workflow create refuses to clobber an existing workflow", () => {
    const repo = createTempRepo();
    const first = runSmithers(["workflow", "create", "dup"], { cwd: repo.dir, format: "json" });
    expect(first.exitCode).toBe(0);
    repo.write(".smithers/workflows/dup.tsx", "// hand-edited\n");

    const second = runSmithers(["workflow", "create", "dup"], { cwd: repo.dir, format: "json" });
    expect(second.exitCode).not.toBe(0);
    // The user's edit survives — create never overwrites.
    expect(repo.read(".smithers/workflows/dup.tsx")).toContain("// hand-edited");
}, 15_000);
