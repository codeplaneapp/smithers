import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createExecutableDir, createTempRepo, runSmithers, writeFakeCodexBinary, } from "../../../packages/smithers/tests/e2e-helpers.js";
/**
 * @param {string} homeDir
 */
function buildInitEnv(homeDir) {
    const binDir = createExecutableDir();
    writeFakeCodexBinary(binDir);
    return {
        HOME: homeDir,
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        OPENAI_API_KEY: "test-openai-key",
        ANTHROPIC_API_KEY: "",
        GEMINI_API_KEY: "",
        GOOGLE_API_KEY: "",
    };
}
/**
 * @param {TempRepo} repo
 */
function writeWorkflowPackTypecheckHarness(repo) {
    repo.write(".smithers/types/e2e-shims.d.ts", [
        'declare module "*.mdx" {',
        "  const Component: any;",
        "  export default Component;",
        "}",
        "",
    ].join("\n"));
    repo.write(".smithers/types/smithers-orchestrator.d.ts", [
        'declare module "smithers-orchestrator" {',
        "  export type AgentLike = any;",
        "  export type OutputTarget = any;",
        "  export type SmithersCtx<T = any> = any;",
        "  export const Workflow: any;",
        "  export const Task: any;",
        "  export const Sequence: any;",
        "  export const Parallel: any;",
        "  export const Ralph: any;",
        "  export const Branch: any;",
        "  export const Loop: any;",
        "  export const Approval: any;",
        "  export const HumanTask: any;",
        "  export const ScanFixVerify: any;",
        "  export const ContinueAsNew: any;",
        "  export const Sandbox: any;",
        "  export const Signal: any;",
        "  export const Timer: any;",
        "  export const WaitForEvent: any;",
        "  export const Worktree: any;",
        "  export const Gateway: any;",
        "  export const ClaudeCodeAgent: any;",
        "  export const CodexAgent: any;",
        "  export const OpenCodeAgent: any;",
        "  export const AntigravityAgent: any;",
        "  export const GeminiAgent: any;",
        "  export const tools: any;",
        "  export const read: any;",
        "  export const write: any;",
        "  export const edit: any;",
        "  export const grep: any;",
        "  export const bash: any;",
        "  export function createSmithers(...args: any[]): any;",
        "  export function defineTool(...args: any[]): any;",
        "  export function mdxPlugin(...args: any[]): any;",
        "}",
        "",
    ].join("\n"));
    repo.write(".smithers/types/smithers-orchestrator-jsx-runtime.d.ts", [
        'declare module "smithers-orchestrator/jsx-runtime" {',
        "  export const Fragment: any;",
        "  export function jsx(type: any, props: any, key?: any): any;",
        "  export function jsxs(type: any, props: any, key?: any): any;",
        "  export function jsxDEV(type: any, props: any, key?: any): any;",
        "}",
        "",
    ].join("\n"));
    repo.write(".smithers/types/smithers-orchestrator-gateway-react.d.ts", [
        'declare module "smithers-orchestrator/gateway-react" {',
        "  export const createGatewayReactRoot: any;",
        "  export function useGatewayActions(): any;",
        "  export function useGatewayApprovals(...args: any[]): any;",
        "  export function useGatewayNodeOutput(...args: any[]): any;",
        "  export function useGatewayRun(...args: any[]): any;",
        "  export function useGatewayRunEvents(...args: any[]): any;",
        "  export function useGatewayRuns(...args: any[]): any;",
        "}",
        "",
    ].join("\n"));
    repo.write(".smithers/tsconfig.e2e.json", JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: {
            strict: false,
            noImplicitAny: false,
            types: ["node", "react", "react-dom", "mdx"],
            paths: {
                "~/*": ["./*"],
                "smithers-orchestrator": ["./types/smithers-orchestrator.d.ts"],
                "smithers-orchestrator/gateway-react": ["./types/smithers-orchestrator-gateway-react.d.ts"],
                "smithers-orchestrator/jsx-runtime": ["./types/smithers-orchestrator-jsx-runtime.d.ts"],
            },
        },
        include: [
            "./agents.ts",
            "./agents/**/*.ts",
            "./components/**/*.ts",
            "./components/**/*.tsx",
            "./preload.ts",
            "./gateway.ts",
            "./smithers.config.ts",
            "./types/**/*.d.ts",
            "./ui/**/*.ts",
            "./ui/**/*.tsx",
            "./workflows/**/*.ts",
            "./workflows/**/*.tsx",
        ],
        exclude: [
            "./executions/**/*",
        ],
    }, null, 2) + "\n");
}
/**
 * @param {TempRepo} repo
 */
function runWorkflowPackTypecheck(repo) {
    writeWorkflowPackTypecheckHarness(repo);
    const typecheck = spawnSync("tsc", ["--noEmit", "--project", "tsconfig.e2e.json"], {
        cwd: repo.path(".smithers"),
        encoding: "utf8",
        env: {
            ...process.env,
            PATH: `${repo.path("node_modules", ".bin")}:${process.env.PATH ?? ""}`,
        },
    });
    if (typecheck.status !== 0) {
        throw new Error([
            "workflow-pack smoke typecheck failed",
            typecheck.stdout,
            typecheck.stderr,
        ].filter(Boolean).join("\n"));
    }
}
test("E2E harness can invoke the Smithers CLI from a temp repo", () => {
    const repo = createTempRepo();
    const result = runSmithers(["--help"], {
        cwd: repo.dir,
        format: null,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: smithers <command>");
    expect(result.stdout).toContain("smithers@");
});
// FLAKY: passes individually but fails in full suite due to test ordering/state leakage.
// See .smithers/tickets/fix-flaky-tests.md
test("smithers init writes the expected workflow-pack layout and it typechecks", () => {
    const repo = createTempRepo();
    const env = buildInitEnv(repo.dir);
    const result = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env,
    });
    expect(result.exitCode).toBe(0);
    expect(repo.exists(".smithers/.gitignore")).toBe(true);
    // PGlite stores and migration receipts are local runtime state when present
    // and must never be committed, even though the clean default backend is SQLite.
    expect(repo.read(".smithers/.gitignore")).toContain("pg/");
    expect(repo.read(".smithers/.gitignore")).toContain("migrated.json");
    expect(repo.exists(".smithers/workflows/.gitignore")).toBe(true);
    expect(repo.exists(".smithers/package.json")).toBe(true);
    expect(repo.exists(".smithers/tsconfig.json")).toBe(true);
    expect(repo.exists(".smithers/bunfig.toml")).toBe(true);
    expect(repo.exists(".smithers/preload.ts")).toBe(true);
    expect(repo.exists(".smithers/gateway.ts")).toBe(true);
    expect(repo.exists(".smithers/agents.ts")).toBe(true);
    expect(repo.exists(".smithers/agents/claude-code.ts")).toBe(true);
    expect(repo.exists(".smithers/agents/codex.ts")).toBe(true);
    expect(repo.exists(".smithers/agents/opencode.ts")).toBe(true);
    expect(repo.exists(".smithers/agents/antigravity.ts")).toBe(true);
    expect(repo.exists(".smithers/agents/gemini.ts")).toBe(false);
    expect(repo.exists(".smithers/agents/index.ts")).toBe(true);
    expect(repo.exists(".smithers/agents/README.md")).toBe(true);
    expect(repo.exists(".smithers/smithers.config.ts")).toBe(true);
    expect(repo.exists(".smithers/prompts/review.mdx")).toBe(true);
    expect(repo.exists(".smithers/prompts/plan.mdx")).toBe(true);
    expect(repo.exists(".smithers/prompts/implement.mdx")).toBe(true);
    expect(repo.exists(".smithers/prompts/validate.mdx")).toBe(true);
    expect(repo.exists(".smithers/components/Review.tsx")).toBe(true);
    expect(repo.exists(".smithers/components/ValidationLoop.tsx")).toBe(true);
    expect(repo.exists(".smithers/prompts/research.mdx")).toBe(true);
    expect(repo.exists(".smithers/workflows/implement.tsx")).toBe(true);
    expect(repo.exists(".smithers/workflows/review.tsx")).toBe(true);
    expect(repo.exists(".smithers/workflows/plan.tsx")).toBe(true);
    expect(repo.exists(".smithers/workflows/research.tsx")).toBe(true);
    expect(repo.exists(".smithers/workflows/ticket-create.tsx")).toBe(true);
    expect(repo.exists(".smithers/workflows/research-plan-implement.tsx")).toBe(true);
    expect(repo.exists(".smithers/workflows/tickets-create.tsx")).toBe(true);
    expect(repo.exists(".smithers/workflows/ralph.tsx")).toBe(true);
    expect(repo.exists(".smithers/workflows/improve-test-coverage.tsx")).toBe(true);
    expect(repo.exists(".smithers/workflows/test-first.tsx")).toBe(false);
    expect(repo.exists(".smithers/workflows/debug.tsx")).toBe(true);
    expect(repo.exists(".smithers/workflows/grill-me.tsx")).toBe(true);
    expect(repo.exists(".smithers/workflows/feature-enum.tsx")).toBe(true);
    expect(repo.exists(".smithers/workflows/audit.tsx")).toBe(true);
    expect(repo.exists(".smithers/workflows/mission.tsx")).toBe(true);
    expect(repo.exists(".smithers/workflows/workflow-skill.tsx")).toBe(true);
    expect(repo.exists(".smithers/workflows/kanban.tsx")).toBe(true);
    expect(repo.exists(".smithers/ui/kanban.tsx")).toBe(true);
    expect(repo.exists(".smithers/skills/.gitkeep")).toBe(true);
    expect(repo.exists(".smithers/prompts/mission-plan.mdx")).toBe(true);
    expect(repo.exists(".smithers/prompts/mission-worker.mdx")).toBe(true);
    expect(repo.exists(".smithers/prompts/mission-integrate.mdx")).toBe(true);
    expect(repo.exists(".smithers/prompts/mission-validate.mdx")).toBe(true);
    expect(repo.exists(".smithers/prompts/mission-follow-up.mdx")).toBe(true);
    expect(repo.exists(".smithers/prompts/mission-final.mdx")).toBe(true);
    expect(repo.exists(".smithers/prompts/workflow-skill.mdx")).toBe(true);
    expect(repo.exists(".smithers/prompts/ask-user-instructions.mdx")).toBe(true);
    expect(repo.exists(".smithers/components/GrillMe.tsx")).toBe(true);
    expect(repo.exists(".smithers/components/CommandProbe.tsx")).toBe(true);
    expect(repo.exists(".smithers/components/ForEachFeature.tsx")).toBe(true);
    expect(repo.exists(".smithers/components/FeatureEnum.tsx")).toBe(true);
    expect(repo.exists(".smithers/tickets/.gitkeep")).toBe(true);
    expect(repo.read(".smithers/workflows/feature-enum.tsx")).toContain("existingFeatures: z.record(z.string(), z.array(z.string())).nullable().default(null)");
    expect(repo.read(".smithers/workflows/audit.tsx")).toContain("features: z.record(z.string(), z.array(z.string())).default({})");
    expect(repo.read(".smithers/workflows/mission.tsx")).toContain('id="mission:approve-plan"');
    expect(repo.read(".smithers/workflows/workflow-skill.tsx")).toContain('WorkflowSkillPrompt');
    expect(repo.read(".smithers/gateway.ts")).toContain("process.chdir(projectRoot);");
    expect(repo.read(".smithers/ui/kanban.tsx")).toContain('nodeId: "tickets", iteration: 0');
    expect(repo.read(".smithers/workflows/kanban.tsx")).toContain('<Task id="tickets" output={outputs.tickets}>');
    runWorkflowPackTypecheck(repo);
}, 20_000);
test("smithers init --template preserves the default scaffold and returns the selected starter", () => {
    const repo = createTempRepo();
    const env = buildInitEnv(repo.dir);
    const result = runSmithers(["init", "--template", "idea-to-tickets", "--no-install"], {
        cwd: repo.dir,
        format: "json",
        env,
    });
    expect(result.exitCode).toBe(0);
    expect(repo.exists(".smithers/workflows/tickets-create.tsx")).toBe(true);
    expect(repo.exists(".smithers/workflows/implement.tsx")).toBe(true);
    expect(result.json.template.id).toBe("idea-to-tickets");
    expect(result.json.template.workflow).toBe("tickets-create");
    expect(result.json.template.command).toStartWith("bunx smithers-orchestrator workflow run tickets-create --");
    expect(result.json.install).toMatchObject({
        reason: "skip-install",
        status: "skipped",
    });
});
test("smithers init rejects unknown templates in option validation before writing the scaffold", () => {
    const repo = createTempRepo();
    const result = runSmithers(["init", "--template", "does-not-exist", "--no-install"], {
        cwd: repo.dir,
        format: "json",
    });
    expect(result.exitCode).toBe(4);
    expect(result.json.code).toBe("VALIDATION_ERROR");
    expect(result.json.message).toContain("Invalid input");
    expect(result.json.fieldErrors).toHaveLength(1);
    expect(result.json.fieldErrors[0]).toMatchObject({
        path: "template",
        expected: "",
        received: "",
        message: "Invalid input",
    });
    expect(repo.exists(".smithers")).toBe(false);
});
test("smithers init rejects starter aliases before writing the scaffold", () => {
    const repo = createTempRepo();
    const result = runSmithers(["init", "--template", "tickets", "--no-install"], {
        cwd: repo.dir,
        format: "json",
    });
    expect(result.exitCode).toBe(4);
    expect(result.json.code).toBe("VALIDATION_ERROR");
    expect(repo.exists(".smithers")).toBe(false);
});
test("smithers init --agents-only creates only the user-owned agent scaffold", () => {
    const repo = createTempRepo();
    const result = runSmithers(["init", "--agents-only"], {
        cwd: repo.dir,
        format: "json",
    });
    expect(result.exitCode).toBe(0);
    expect(repo.exists(".smithers/agents/claude-code.ts")).toBe(true);
    expect(repo.exists(".smithers/agents/codex.ts")).toBe(true);
    expect(repo.exists(".smithers/agents/opencode.ts")).toBe(true);
    expect(repo.exists(".smithers/agents/antigravity.ts")).toBe(true);
    expect(repo.exists(".smithers/agents/gemini.ts")).toBe(false);
    expect(repo.exists(".smithers/agents/index.ts")).toBe(true);
    expect(repo.exists(".smithers/agents/README.md")).toBe(true);
    expect(repo.exists(".smithers/agents.ts")).toBe(false);
    expect(repo.exists(".smithers/package.json")).toBe(false);
    expect(repo.exists(".smithers/prompts")).toBe(false);
    expect(repo.exists(".smithers/workflows")).toBe(false);
    expect(result.json).toMatchObject({
        install: {
            reason: "agents-only",
            status: "skipped",
        },
    });
});
test("smithers init --agents-only is idempotent and preserves user edits", () => {
    const repo = createTempRepo();
    const first = runSmithers(["init", "--agents-only"], {
        cwd: repo.dir,
        format: "json",
    });
    expect(first.exitCode).toBe(0);
    const sentinel = `${repo.read(".smithers/agents/codex.ts").trimEnd()}\n// sentinel user edit\n`;
    repo.write(".smithers/agents/codex.ts", sentinel);
    const second = runSmithers(["init", "--agents-only"], {
        cwd: repo.dir,
        format: "json",
    });
    expect(second.exitCode).toBe(0);
    expect(repo.read(".smithers/agents/codex.ts")).toContain("// sentinel user edit");
    expect(second.json).toMatchObject({
        install: {
            reason: "agents-only",
            status: "skipped",
        },
        writtenFiles: [],
    });
    expect(second.stderr).toContain("skipped: already exists");
});
test("smithers init preserves .smithers/executions on an existing repo", () => {
    const repo = createTempRepo();
    const env = buildInitEnv(repo.dir);
    repo.write(".smithers/executions/existing-run/logs/events.ndjson", '{"type":"RunFinished"}\n');
    const result = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env,
    });
    expect(result.exitCode).toBe(0);
    expect(repo.read(".smithers/executions/existing-run/logs/events.ndjson")).toContain("RunFinished");
});
test("smithers init does not clobber user edits unless --force is passed", () => {
    const repo = createTempRepo();
    const env = buildInitEnv(repo.dir);
    const first = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env,
    });
    expect(first.exitCode).toBe(0);
    repo.write(".smithers/workflows/implement.tsx", "// user-edited workflow\nexport default {};\n");
    const second = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env,
    });
    expect(second.exitCode).toBe(0);
    expect(repo.read(".smithers/workflows/implement.tsx")).toContain("user-edited workflow");
    const forced = runSmithers(["init", "--force"], {
        cwd: repo.dir,
        format: "json",
        env,
    });
    expect(forced.exitCode).toBe(0);
    expect(repo.read(".smithers/workflows/implement.tsx")).not.toContain("user-edited workflow");
}, 15_000);
test("workflow inspect and skills use seeded workflow metadata", () => {
    const repo = createTempRepo();
    const env = buildInitEnv(repo.dir);
    const initResult = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env,
    });
    expect(initResult.exitCode).toBe(0);

    const inspect = runSmithers(["workflow", "inspect", "implement"], {
        cwd: repo.dir,
        format: "json",
    });
    expect(inspect.exitCode).toBe(0);
    expect(inspect.json.workflow).toMatchObject({
        id: "implement",
        displayName: "Implement",
        sourceType: "seeded",
        description: "Implement a focused change with validation and review feedback loops.",
        tags: ["coding", "implementation", "review"],
    });
    expect(inspect.json.skillPreview).toContain("smithers workflow run implement");
    expect(inspect.json.inputSchema.fields).toEqual(expect.arrayContaining([
        expect.objectContaining({
            name: "prompt",
            type: "string",
            default: "Implement the requested change.",
        }),
    ]));

    const skills = runSmithers(["workflow", "skills", "implement", "--output", "docs/implement-skill.md"], {
        cwd: repo.dir,
        format: "json",
    });
    expect(skills.exitCode).toBe(0);
    expect(skills.json.writtenFiles).toHaveLength(1);
    expect(repo.read("docs/implement-skill.md")).toContain("name: implement");
    expect(repo.read("docs/implement-skill.md")).toContain("Implement a focused change");
    expect(repo.read("docs/implement-skill.md")).toContain("| `prompt` | `string` |");

    const reportInspect = runSmithers(["workflow", "inspect", "report-slideshow"], {
        cwd: repo.dir,
        format: "json",
    });
    expect(reportInspect.exitCode).toBe(0);
    expect(reportInspect.json.inputSchema.fields).toEqual(expect.arrayContaining([
        expect.objectContaining({
            name: "targetRunId",
            type: "string",
            required: true,
        }),
        expect.objectContaining({
            name: "title",
            type: "string | null",
            default: null,
        }),
    ]));
    expect(reportInspect.json.skillPreview).toContain("| `targetRunId` | `string` | required |");
    expect(reportInspect.json.skillPreview).toContain("| `title` | `string | null` | default: `null` |");
}, 15_000);
test("seeded workflows reuse the shared review substrate", () => {
    const repo = createTempRepo();
    const env = buildInitEnv(repo.dir);
    const initResult = runSmithers(["init"], {
        cwd: repo.dir,
        format: "json",
        env,
    });
    expect(initResult.exitCode).toBe(0);
    const implementSource = repo.read(".smithers/workflows/implement.tsx");
    const researchPlanImplementSource = repo.read(".smithers/workflows/research-plan-implement.tsx");
    const coverageSource = repo.read(".smithers/workflows/improve-test-coverage.tsx");
    expect(implementSource).toContain('../components/Review');
    expect(researchPlanImplementSource).toContain('../components/ValidationLoop');
    expect(coverageSource).toContain('../components/ValidationLoop');
    for (const [workflowName, reviewPrefix] of [
        ["implement", "impl:review"],
        ["research-plan-implement", "impl:review"],
        ["improve-test-coverage", "improve-test-coverage:review"],
    ]) {
        const graph = runSmithers([
            "graph",
            `.smithers/workflows/${workflowName}.tsx`,
            "--input",
            JSON.stringify({ prompt: "hello" }),
        ], {
            cwd: repo.dir,
            format: "json",
        });
        expect(graph.exitCode).toBe(0);
        expect(JSON.stringify(graph.json)).toContain(`${reviewPrefix}:0`);
    }
}, 60_000);
