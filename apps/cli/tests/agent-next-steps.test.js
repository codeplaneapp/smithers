import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAgentNextSteps } from "../src/agentNextSteps.js";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

describe("buildAgentNextSteps", () => {
    test("returns a cta fragment shaped for incur ({ description, commands })", () => {
        const next = buildAgentNextSteps({
            workflowId: "implement",
            workflowFile: ".smithers/workflows/implement.tsx",
            runId: "run-1",
            hasUi: false,
        });
        expect(typeof next.description).toBe("string");
        expect(Array.isArray(next.commands)).toBe(true);
        for (const cmd of next.commands) {
            expect(typeof cmd.command).toBe("string");
            expect(typeof cmd.description).toBe("string");
        }
    });

    test("speaks to the agent: suggest to the user, ask clarifying questions, build a workflow", () => {
        const next = buildAgentNextSteps({ workflowId: "implement", runId: "run-1" });
        expect(next.description).toStartWith("Suggest to the user:");
        expect(next.description).toContain("Ask the user clarifying questions about what they want next");
        expect(next.description).toContain("smithers workflow run create-workflow --prompt");
        expect(next.description).toContain("smithers make-workflow");
        const commandStrings = next.commands.map((cmd) => cmd.command);
        expect(commandStrings).toContain('workflow run create-workflow --prompt "<describe the workflow>"');
    });

    test("without a custom UI, the FIRST suggestion is authoring .smithers/ui/<id>.tsx with gateway-react", () => {
        const next = buildAgentNextSteps({ workflowId: "implement", runId: "run-1", hasUi: false });
        const firstStep = next.description.split("\n")[1];
        expect(firstStep).toContain(".smithers/ui/implement.tsx");
        expect(firstStep).toContain("gateway-react");
        expect(firstStep).toContain('<UI entry="../ui/implement.tsx"');
        expect(firstStep).toContain("smithers ui run-1");
        expect(firstStep).toContain("smithers ui --app");
        expect(next.commands.map((cmd) => cmd.command)).toContain("ui --app");
    });

    test("with an existing custom UI, it suggests opening it instead of authoring one", () => {
        const next = buildAgentNextSteps({ workflowId: "implement", runId: "run-1", hasUi: true });
        expect(next.description).toContain("a UI already exists at .smithers/ui/implement.tsx");
        expect(next.description).not.toContain("author .smithers/ui/implement.tsx");
        expect(next.commands[0]).toEqual({ command: "ui run-1", description: "Open the custom workflow UI" });
    });

    test("probes a workflow-owned .smithers/ui/<id>.tsx under cwd when hasUi is not supplied", () => {
        const repo = createTempRepo();
        mkdirSync(join(repo.dir, ".smithers", "ui"), { recursive: true });
        mkdirSync(join(repo.dir, ".smithers", "workflows"), { recursive: true });
        writeFileSync(join(repo.dir, ".smithers", "ui", "implement.tsx"), "export default null;\n");
        writeFileSync(join(repo.dir, ".smithers", "workflows", "implement.tsx"), '<Workflow name="implement"><UI entry="../ui/implement.tsx" /></Workflow>\n');
        const withUi = buildAgentNextSteps({ workflowId: "implement", runId: "run-1", cwd: repo.dir });
        expect(withUi.commands[0].description).toBe("Open the custom workflow UI");
        const withoutUi = buildAgentNextSteps({ workflowId: "other", runId: "run-1", cwd: repo.dir });
        expect(withoutUi.description).toContain(".smithers/ui/other.tsx");
    });

    test("includes visualize suggestions: graph, tree, and the --interactive TUI", () => {
        const next = buildAgentNextSteps({
            workflowId: "implement",
            workflowFile: "flow.tsx",
            runId: "run-1",
            hasUi: false,
        });
        expect(next.description).toContain("smithers graph flow.tsx");
        expect(next.description).toContain("smithers tree run-1");
        expect(next.description).toContain("smithers up --interactive");
        const commandStrings = next.commands.map((cmd) => cmd.command);
        expect(commandStrings).toContain("graph flow.tsx");
        expect(commandStrings).toContain("tree run-1");
    });

    test("omitUi drops the UI suggestion but keeps visualize + build-a-workflow", () => {
        const next = buildAgentNextSteps({ workflowId: "implement", runId: "run-1", omitUi: true });
        expect(next.description).not.toContain(".smithers/ui/implement.tsx");
        expect(next.description).toContain("smithers tree run-1");
        expect(next.description).toContain("Ask the user clarifying questions");
        expect(next.commands.map((cmd) => cmd.command)).not.toContain("ui run-1");
    });

    test("uiOpened variant suggests iterating on the UI file, ui --app, and UIs for other workflows", () => {
        const next = buildAgentNextSteps({ workflowId: "implement", runId: "run-1", hasUi: true, uiOpened: true });
        expect(next.description).toContain(".smithers/ui/implement.tsx");
        expect(next.description).toContain("smithers ui --app");
        expect(next.description).toContain("other workflows that lack one");
        expect(next.description).toContain("Ask the user clarifying questions");
        expect(next.commands.map((cmd) => cmd.command)).toContain("ui --app");
    });

    test("uiOpened variant numbers every suggestion, including the trailing build-a-workflow line (#28)", () => {
        const next = buildAgentNextSteps({ workflowId: "implement", runId: "run-1", hasUi: true, uiOpened: true });
        expect(next.description).toContain("\n4. Ask the user clarifying questions");
        const numberedLines = next.description
            .split("\n")
            .filter((line) => /^\d+\. /.test(line));
        expect(numberedLines).toHaveLength(4);
    });

    test("justRan: \"graph\" drops the graph self-suggestion but keeps tree, UI, and build-a-workflow (#29)", () => {
        const next = buildAgentNextSteps({
            workflowId: "implement",
            workflowFile: "flow.tsx",
            runId: "run-1",
            hasUi: false,
            justRan: "graph",
        });
        const commandStrings = next.commands.map((cmd) => cmd.command);
        expect(commandStrings).not.toContain("graph flow.tsx");
        expect(next.description).not.toContain("smithers graph flow.tsx");
        expect(commandStrings).toContain("tree run-1");
        expect(next.description).toContain("smithers tree run-1");
        expect(next.description).toContain("Ask the user clarifying questions");
        expect(commandStrings).toContain('workflow run create-workflow --prompt "<describe the workflow>"');
    });

    test("justRan: \"tree\" swaps the tree self-suggestion for tree --watch (#29)", () => {
        const next = buildAgentNextSteps({
            workflowId: "implement",
            workflowFile: "flow.tsx",
            runId: "run-1",
            hasUi: false,
            justRan: "tree",
        });
        const commandStrings = next.commands.map((cmd) => cmd.command);
        expect(commandStrings).not.toContain("tree run-1");
        expect(commandStrings).toContain("tree run-1 --watch");
        expect(next.description).toContain("smithers tree run-1 --watch");
        expect(commandStrings).toContain("graph flow.tsx");
    });

    test("uses placeholders when no run or workflow is known and never uses em-dashes", () => {
        const next = buildAgentNextSteps({});
        expect(next.description).toContain("<runId>");
        expect(next.description).toContain("<workflowId>");
        for (const value of [next.description, ...next.commands.flatMap((cmd) => [cmd.command, cmd.description])]) {
            expect(value).not.toContain("—");
        }
    });
});

describe("agent next steps in command ctas", () => {
    test("workflow list --format json embeds the agent guidance as a structured cta", () => {
        const repo = createTempRepo();
        mkdirSync(join(repo.dir, ".smithers", "workflows"), { recursive: true });
        writeFileSync(join(repo.dir, ".smithers", "workflows", "hello.tsx"), "export default {};\n");
        const result = runSmithers(["workflow", "list"], { cwd: repo.dir, format: "json" });
        expect(result.exitCode).toBe(0);
        const cta = result.json?.cta ?? result.json?.meta?.cta;
        expect(cta).toBeDefined();
        expect(cta.description).toStartWith("Suggest to the user:");
        expect(cta.description).toContain("Ask the user clarifying questions");
        expect(cta.description).toContain("smithers up --interactive");
        expect(cta.commands.some((cmd) => String(cmd.command).includes("create-workflow"))).toBe(true);
    }, 60_000);
});

describe("buildAgentNextSteps human mode", () => {
    test("returns a concise human list, not the agent script", () => {
        const next = buildAgentNextSteps({
            workflowId: "hello",
            workflowFile: ".smithers/workflows/hello.tsx",
            runId: "run-9",
            hasUi: false,
            human: true,
        });
        // The human fragment carries no header of its own (the caller supplies
        // "Next steps:"); it must not emit the agent script.
        expect(next.description).toBe("");
        expect(next.description).not.toContain("Suggest to the user");
        const joined = next.commands.map((c) => `${c.command} ${c.description}`).join("\n");
        expect(joined).not.toContain("clarifying questions");
        expect(next.commands.some((c) => c.command === "inspect run-9")).toBe(true);
        expect(next.commands.some((c) => c.command.startsWith("make-workflow"))).toBe(true);
    });

    test("offers the workflow UI command only when one exists", () => {
        const withUi = buildAgentNextSteps({ workflowId: "hello", runId: "r1", hasUi: true, human: true });
        expect(withUi.commands.some((c) => c.command === "ui r1")).toBe(true);
        const withoutUi = buildAgentNextSteps({ workflowId: "hello", runId: "r1", hasUi: false, human: true });
        expect(withoutUi.commands.some((c) => c.command === "ui r1")).toBe(false);
    });

    test("relativizes an absolute workflow path under the cwd", () => {
        const cwd = "/home/dev/proj";
        const next = buildAgentNextSteps({
            workflowId: "hello",
            workflowFile: "/home/dev/proj/.smithers/workflows/hello.tsx",
            runId: "r1",
            hasUi: false,
            human: true,
            cwd,
        });
        const graph = next.commands.find((c) => c.command.startsWith("graph "));
        expect(graph?.command).toBe("graph .smithers/workflows/hello.tsx");
    });

    test("leaves an absolute path outside the cwd absolute (agent mode)", () => {
        const cwd = "/home/dev/proj";
        const next = buildAgentNextSteps({
            workflowId: "hello",
            workflowFile: "/other/place/hello.tsx",
            runId: "r1",
            cwd,
        });
        expect(next.description).toContain("/other/place/hello.tsx");
    });
});
