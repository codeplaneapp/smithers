import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.js");
const EXAMPLES_DIR = resolve(REPO_ROOT, "examples");

// The committed examples import the AI SDK (`ai`, `@ai-sdk/anthropic`) purely to
// declare agents; those packages are deliberately NOT installed at the repo root
// (see docs-examples-smoke.test.js, which stubs them the same way). Rendering a
// workflow graph only loads the module — it never invokes an agent — so a tiny
// stub resolvable from examples/ is enough to let every example load. Each test
// process gets a private copy of examples/ so concurrent CLI suites cannot
// remove another process's stubs midway through the render loop.
const AI_STUB_PACKAGES = {
    "ai/package.json": JSON.stringify({ type: "module", exports: { ".": "./index.js" } }) + "\n",
    "ai/index.js": [
        "export class ToolLoopAgent { constructor(opts = {}) { this.opts = opts; } }",
        "export const Output = { object(value) { return value; } };",
        "export function stepCountIs() { return () => false; }",
        "export function tool(def) { return def; }",
        "",
    ].join("\n"),
    "@ai-sdk/anthropic/package.json": JSON.stringify({ type: "module", exports: { ".": "./index.js" } }) + "\n",
    "@ai-sdk/anthropic/index.js": "export function anthropic(model) { return { provider: \"anthropic\", model }; }\n",
    "@ai-sdk/openai/package.json": JSON.stringify({ type: "module", exports: { ".": "./index.js" } }) + "\n",
    "@ai-sdk/openai/index.js": "export function openai(model) { return { provider: \"openai\", model }; }\n",
};

function createExampleProject() {
    const projectDir = mkdtempSync(resolve(tmpdir(), "smithers-example-graphs-"));
    const projectExamplesDir = resolve(projectDir, "examples");
    cpSync(EXAMPLES_DIR, projectExamplesDir, {
        recursive: true,
        filter(source) {
            const pathFromExamples = relative(EXAMPLES_DIR, source);
            return pathFromExamples !== "node_modules" && !pathFromExamples.startsWith(`node_modules${sep}`);
        },
    });

    // Keep ordinary workspace dependencies identical to the checkout while
    // letting the copied examples override only the intentionally absent SDKs.
    symlinkSync(resolve(REPO_ROOT, "node_modules"), resolve(projectDir, "node_modules"), "dir");

    const modulesDir = resolve(projectExamplesDir, "node_modules");
    for (const [relative, contents] of Object.entries(AI_STUB_PACKAGES)) {
        const target = resolve(modulesDir, relative);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, contents, "utf8");
    }

    return {
        projectDir,
        cleanup: () => rmSync(projectDir, { recursive: true, force: true }),
    };
}
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

    const exampleProject = createExampleProject();
    try {
        for (const example of examples) {
            const copiedExample = resolve(exampleProject.projectDir, example);
            const result = spawnSync(process.execPath, [
                "run",
                CLI_ENTRY,
                "graph",
                copiedExample,
                "--input",
                JSON.stringify(GRAPH_INPUT),
                "--format",
                "json",
            ], {
                cwd: exampleProject.projectDir,
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
    } finally {
        exampleProject.cleanup();
    }
}, 240_000);
