import { expect, test } from "bun:test";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const WORKFLOW = `/** @jsxImportSource smithers-orchestrator */
import { createSmithers } from "smithers-orchestrator";
import { z } from "zod";

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: z.object({ tickets: z.array(z.string()).default(["default-ticket"]) }),
  result: z.object({ ticket: z.string() }),
});

export default smithers((ctx) => (
  <Workflow name="input-default-preview">
    {ctx.input.tickets.map((ticket) => <Task id={ticket} key={ticket} output={outputs.result}>{{ ticket }}</Task>)}
  </Workflow>
));
`;

test("graph applies input defaults and preserves INVALID_INPUT", () => {
    const repo = createTempRepo();
    repo.write("workflow.tsx", WORKFLOW);

    const graph = runSmithers(["graph", "workflow.tsx"], {
        cwd: repo.dir,
        format: "json",
    });
    expect(graph.exitCode, `${graph.stdout}\n${graph.stderr}`).toBe(0);
    expect(graph.json?.tasks?.map((task) => task.nodeId)).toContain("default-ticket");

    const malformed = runSmithers([
        "graph",
        "workflow.tsx",
        "--input",
        JSON.stringify({ tickets: "not-an-array" }),
    ], {
        cwd: repo.dir,
        format: "json",
    });
    expect(malformed.exitCode, `${malformed.stdout}\n${malformed.stderr}`).toBe(4);
    expect(malformed.json?.code).toBe("INVALID_INPUT");
});

test("detached launch preflight applies input defaults", () => {
    const repo = createTempRepo();
    repo.write("workflow.tsx", WORKFLOW);

    const result = runSmithers([
        "up",
        "workflow.tsx",
        "--detach",
        "--run-id",
        "input-default-preflight",
    ], {
        cwd: repo.dir,
        format: "json",
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);

    const malformed = runSmithers([
        "up",
        "workflow.tsx",
        "--detach",
        "--run-id",
        "input-invalid-preflight",
        "--input",
        JSON.stringify({ tickets: "not-an-array" }),
    ], {
        cwd: repo.dir,
        format: "json",
    });
    expect(malformed.exitCode, `${malformed.stdout}\n${malformed.stderr}`).toBe(4);
    expect(malformed.json?.code).toBe("INVALID_INPUT");
});
