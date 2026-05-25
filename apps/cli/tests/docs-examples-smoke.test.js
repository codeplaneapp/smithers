import { expect, onTestFinished, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
    readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.js");
const RELATIVE_IMPORT_PATTERN = new RegExp("from [\\\"\\x27][.]{1,2}/");
const SEEDED_WORKFLOW_PACKAGE_PATTERN = new RegExp("from [\\\"\\x27]smithers-workflows/");
const GRAPH_INPUT = {
    name: "World",
    repo: ".",
    goal: "Test docs example",
    change: "demo",
    diff: "diff --git a/x b/x",
    maxIterations: 2,
};
const EXPECTED_SINGLE_FILE_WORKFLOW_DOCS = [
    "docs/components/approval.mdx",
    "docs/components/human-task.mdx",
    "docs/components/signal.mdx",
    "docs/components/workflow.mdx",
    "docs/index.mdx",
    "docs/integrations/cli-agents.mdx",
    "docs/integrations/server.mdx",
    "docs/integrations/tools.mdx",
    "docs/jsx/overview.mdx",
    "docs/tour.mdx",
    "docs/examples/approval-gate.mdx",
    "docs/examples/claude-plugin-orchestrator.mdx",
    "docs/examples/dynamic-plan.mdx",
    "docs/examples/hello-world.mdx",
    "docs/examples/loop.mdx",
    "docs/examples/multi-agent-review.mdx",
    "docs/examples/tools-agent.mdx",
    "docs/examples/workflow-approval.mdx",
    "docs/examples/workflow-hello.mdx",
    "docs/examples/workflow-quickstart.mdx",
];
const NON_STANDALONE_WORKFLOW_SNIPPETS = [
    "docs/components/content-pipeline.mdx#2",
    "docs/components/continue-as-new.mdx#2",
    "docs/components/extract-prompt.mdx#2",
    "docs/components/loop-until-scored.mdx#2",
    "docs/components/loop.mdx#2",
    "docs/components/optimizer.mdx#2",
    "docs/components/review-loop.mdx#2",
    "docs/components/runbook.mdx#2",
    "docs/components/supervisor.mdx#2",
    "docs/examples/worktree-feature-workflow.mdx#2",
    "docs/guides/alerting.mdx#2",
    "docs/recipes.mdx#7",
];

/**
 * @param {string} path
 */
function ensureDir(path) {
    mkdirSync(path, { recursive: true });
}

/**
 * @param {string} path
 * @param {string} contents
 */
function writeFile(path, contents) {
    ensureDir(dirname(path));
    writeFileSync(path, contents, "utf8");
}

/**
 * @param {string} target
 * @param {string} path
 */
function symlinkDir(target, path) {
    ensureDir(dirname(path));
    if (!existsSync(path))
        symlinkSync(target, path, "dir");
}

/**
 * @param {string} text
 * @returns {{ lang: string, code: string }[]}
 */
function extractCodeFences(text) {
    const blocks = [];
    const lines = text.split(/\r?\n/);
    let open = null;
    for (const line of lines) {
        if (!open) {
            const match = line.match(/^ {0,3}(```+|~~~+)\s*([^`]*)\s*$/);
            if (match) {
                open = {
                    marker: match[1][0],
                    length: match[1].length,
                    lang: (match[2] ?? "").trim(),
                    body: [],
                };
            }
            continue;
        }
        const closePattern = new RegExp(`^ {0,3}${open.marker}{${open.length},}\\s*$`);
        if (closePattern.test(line)) {
            blocks.push({ lang: open.lang, code: open.body.join("\n") });
            open = null;
            continue;
        }
        open.body.push(line);
    }
    return blocks;
}

function createDocsSnippetProject() {
    const dir = mkdtempSync(join(tmpdir(), "smithers-doc-snippets-"));
    onTestFinished(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    symlinkDir(resolve(REPO_ROOT, "packages/smithers"), join(dir, "node_modules/smithers-orchestrator"));
    symlinkDir(resolve(REPO_ROOT, "node_modules/@smithers-orchestrator"), join(dir, "node_modules/@smithers-orchestrator"));
    symlinkDir(resolve(REPO_ROOT, "node_modules/react"), join(dir, "node_modules/react"));
    symlinkDir(resolve(REPO_ROOT, "node_modules/react-dom"), join(dir, "node_modules/react-dom"));
    symlinkDir(resolve(REPO_ROOT, "node_modules/zod"), join(dir, "node_modules/zod"));
    writeFile(join(dir, "node_modules/ai/package.json"), JSON.stringify({
        type: "module",
        exports: { ".": "./index.js" },
    }) + "\n");
    writeFile(join(dir, "node_modules/ai/index.js"), [
        "export class ToolLoopAgent { constructor(opts = {}) { this.opts = opts; } }",
        "export const Output = { object(value) { return value; } };",
        "export function stepCountIs() { return () => false; }",
        "export function tool(def) { return def; }",
        "",
    ].join("\n"));
    for (const name of ["anthropic", "openai"]) {
        writeFile(join(dir, `node_modules/@ai-sdk/${name}/package.json`), JSON.stringify({
            type: "module",
            exports: { ".": "./index.js" },
        }) + "\n");
        writeFile(join(dir, `node_modules/@ai-sdk/${name}/index.js`), `export function ${name}(model) { return { provider: ${JSON.stringify(name)}, model }; }\n`);
    }
    return dir;
}

function findDocsWorkflowSnippets() {
    const docFiles = Array.from(new Bun.Glob("docs/**/*.{mdx,md}").scanSync({ cwd: REPO_ROOT }))
        .filter((file) => !file.startsWith("docs/changelogs/"))
        .filter((file) => !file.startsWith("docs/design-prompts/"))
        .filter((file) => !file.startsWith("docs/planning/"))
        .sort();
    const snippets = [];
    for (const file of docFiles) {
        const blocks = extractCodeFences(readFileSync(resolve(REPO_ROOT, file), "utf8"));
        blocks.forEach((block, index) => {
            const code = block.code.trim();
            if (!/^(tsx|jsx)$/.test(block.lang))
                return;
            if (!code.includes("export default smithers"))
                return;
            if (!code.includes("createSmithers("))
                return;
            if (RELATIVE_IMPORT_PATTERN.test(code))
                return;
            if (SEEDED_WORKFLOW_PACKAGE_PATTERN.test(code))
                return;
            snippets.push({ file, index: index + 1, code });
        });
    }
    return snippets;
}

function findWorkflowLikeSnippetLabels() {
    const docFiles = Array.from(new Bun.Glob("docs/**/*.{mdx,md}").scanSync({ cwd: REPO_ROOT }))
        .filter((file) => !file.startsWith("docs/changelogs/"))
        .filter((file) => !file.startsWith("docs/design-prompts/"))
        .filter((file) => !file.startsWith("docs/planning/"))
        .sort();
    const labels = [];
    for (const file of docFiles) {
        const blocks = extractCodeFences(readFileSync(resolve(REPO_ROOT, file), "utf8"));
        blocks.forEach((block, index) => {
            const code = block.code.trim();
            if (/^(tsx|jsx)$/.test(block.lang) && code.includes("export default smithers"))
                labels.push(`${file}#${index + 1}`);
        });
    }
    return labels;
}

test("complete single-file workflow snippets in docs render as graphs", () => {
    const projectDir = createDocsSnippetProject();
    const snippets = findDocsWorkflowSnippets();
    const checked = [];

    for (const snippet of snippets) {
        const safeName = snippet.file.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
        const path = join(projectDir, `${safeName}-${snippet.index}.tsx`);
        writeFile(path, `${snippet.code}\n`);
        const result = spawnSync(process.execPath, [
            "run",
            CLI_ENTRY,
            "graph",
            path,
            "--input",
            JSON.stringify(GRAPH_INPUT),
            "--format",
            "json",
        ], {
            cwd: projectDir,
            env: {
                ...process.env,
                ANTHROPIC_API_KEY: "test",
                OPENAI_API_KEY: "test",
            },
            encoding: "utf8",
            maxBuffer: 10 * 1024 * 1024,
        });
        const label = `${snippet.file}#${snippet.index}`;
        if (result.status !== 0) {
            throw new Error(`${label} failed:\nstdout:${result.stdout}\nstderr:${result.stderr}`);
        }
        checked.push(label);
    }

    const checkedFiles = new Set(checked.map((label) => label.split("#")[0]));
    for (const expected of EXPECTED_SINGLE_FILE_WORKFLOW_DOCS) {
        expect(checkedFiles.has(expected)).toBe(true);
    }
    expect(checked.filter((label) => label.startsWith("docs/tour.mdx#"))).toHaveLength(3);

    const checkedLabels = new Set(checked);
    const allowedNonStandalone = new Set(NON_STANDALONE_WORKFLOW_SNIPPETS);
    const unclassified = findWorkflowLikeSnippetLabels()
        .filter((label) => !checkedLabels.has(label))
        .filter((label) => !allowedNonStandalone.has(label));
    expect(unclassified).toEqual([]);
}, 120_000);
