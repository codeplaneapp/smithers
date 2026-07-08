import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.js");
const GRAPH_INPUT = {
    repo: ".",
    goal: "Smoke-test the committed example workflow graph",
    prompt: "Render this example without executing agents",
    change: "demo",
    diff: "diff --git a/example b/example",
    maxIterations: 1,
};

function findTopLevelExampleWorkflows() {
    return Array.from(new Bun.Glob("examples/*.jsx").scanSync({ cwd: REPO_ROOT })).sort();
}

test("top-level example workflows render as graphs", () => {
    const examples = findTopLevelExampleWorkflows();
    expect(examples).toContain("examples/smoketest.jsx");
    expect(examples.length).toBeGreaterThan(50);

    for (const example of examples) {
        const result = spawnSync(process.execPath, [
            "run",
            CLI_ENTRY,
            "graph",
            example,
            "--input",
            JSON.stringify(GRAPH_INPUT),
            "--format",
            "json",
        ], {
            cwd: REPO_ROOT,
            env: {
                ...process.env,
                ANTHROPIC_API_KEY: "sk-ant-test",
                OPENAI_API_KEY: "sk-test",
                GEMINI_API_KEY: "",
                GOOGLE_API_KEY: "",
            },
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024,
        });

        if (result.status !== 0) {
            throw new Error(`${example} failed:\nstdout:${result.stdout}\nstderr:${result.stderr}`);
        }

        const graph = JSON.parse(result.stdout);
        expect(graph.xml?.kind, `${example} did not render an XML graph`).toBe("element");
        expect(Array.isArray(graph.tasks), `${example} did not expose graph tasks`).toBe(true);

        const source = readFileSync(resolve(REPO_ROOT, example), "utf8");
        expect(source.length, `${example} should be a committed source file`).toBeGreaterThan(0);
    }
}, 240_000);
