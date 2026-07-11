import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accountsRoot } from "@smithers-orchestrator/accounts";
import { generateAgentsTs } from "./agent-detection.js";
import { buildComponentImporterMap, componentBaseName } from "./initPackUpdates.js";
import { installCuratedSkill, loadSkillDeselections, saveSkillDeselections, skillTargets } from "./installCuratedSkill.js";
import { noteWorkflowPreferenceInAgentDocs } from "./noteWorkflowPreferenceInAgentDocs.js";
// Seeded workflows authored as canonical files in .smithers/ and emitted by
// scripts/generate-workflow-pack.ts (single source of truth — no hand-embedding).
import { GENERATED_SEEDED_FILES } from "./seeded-workflow-pack.generated.js";
/**
 * @typedef {{ onSkip?: (relPath: string) => void; scaffolded?: (counts: { writtenCount: number; skippedCount: number; preservedCount: number }) => void; skillInstalled?: (result: import("./installCuratedSkill.js").CuratedSkillResult) => void; agentDocsNoted?: (result: import("./noteWorkflowPreferenceInAgentDocs.js").AgentDocsNoteSummary) => void; gitignoreEnsured?: (result: RootGitignoreResult) => void; installStart?: () => void; installDone?: (result: InitInstallResult, captured?: { stdout: string; stderr: string }) => void; }} InitReporter
 */
/**
 * @typedef {{ force?: boolean; rootDir?: string; skipInstall?: boolean; agentsOnly?: boolean; global?: boolean; installSkill?: boolean; skillOptions?: Parameters<typeof installCuratedSkill>[0]; reporter?: InitReporter; env?: NodeJS.ProcessEnv; selectedWorkflows?: string[]; selectedSkillTargets?: string[]; selectedAgentDocs?: string[]; scaffoldCustomAgent?: boolean; }} InitOptions
 */
/**
 * @typedef {{ status: "ok" | "skipped" | "failed"; reason?: string; }} InitInstallResult
 */
/**
 * @typedef {{ path: string; absolutePath: string; contents: string; isComponent: boolean; importedBy: string[] }} ChangedPackFile
 * @typedef {{ status: "created" | "updated" | "unchanged" | "skipped"; path: string; reason?: string; }} RootGitignoreResult
 * @typedef {{ rootDir: string; writtenFiles: string[]; skippedFiles: string[]; preservedPaths: string[]; changedFiles: ChangedPackFile[]; updatedFiles?: string[]; install: InitInstallResult; skill?: import("./installCuratedSkill.js").CuratedSkillResult; agentDocs?: import("./noteWorkflowPreferenceInAgentDocs.js").AgentDocsNoteSummary; gitignore?: RootGitignoreResult; }} InitResult
 */
/**
 * @typedef {{ command: string; description: string; }} WorkflowCta
 */
/**
 * @typedef {{ path: string; contents: string; preserveExisting?: boolean; owners?: string[]; }} TemplateFile
 */

const FALLBACK_SMITHERS_SPEC = "latest";
const require = createRequire(import.meta.url);
const CLI_SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_REPO_ROOT = resolve(CLI_SOURCE_DIR, "../../..");
const SOURCE_SMITHERS_PACKAGE = resolve(SOURCE_REPO_ROOT, "packages/smithers");

/**
 * @param {string} path
 */
function ensureDir(path) {
    mkdirSync(path, { recursive: true });
}
/**
 * @param {string} path
 */
function ensureParent(path) {
    ensureDir(dirname(path));
}
/**
 * @param {string} path
 */
function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}
/**
 * @param {string} path
 * @param {string} fallback
 */
function readPackageVersion(path, fallback) {
    try {
        return String(readJson(path).version ?? fallback);
    }
    catch {
        return fallback;
    }
}
/**
 * Resolve an installed dependency version from the current package layout.
 *
 * @param {string} specifier
 * @param {string} fallback
 */
function resolveInstalledPackageVersion(specifier, fallback) {
    try {
        const resolved = require.resolve(`${specifier}/package.json`);
        return readPackageVersion(resolved, fallback);
    }
    catch {
        return fallback;
    }
}
/**
 * @returns {string | undefined}
 */
function readOwnPackageVersion() {
    try {
        const ownPackagePath = fileURLToPath(new URL("../package.json", import.meta.url));
        const version = readJson(ownPackagePath).version;
        return typeof version === "string" && version.length > 0 ? version : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * @returns {boolean}
 */
function isLocalSourceCheckout() {
    const workspaceManifest = resolve(SOURCE_REPO_ROOT, "pnpm-workspace.yaml");
    const smithersPackageJson = resolve(SOURCE_SMITHERS_PACKAGE, "package.json");
    return existsSync(workspaceManifest) && existsSync(smithersPackageJson);
}
/**
 * Pins shipped with this release for devDep-only specs that won't be in the
 * user's `node_modules` after `bunx smithers-orchestrator@latest init`. Bump
 * these when updating the monorepo's root devDependencies.
 */
const BUNDLED_VERSION_PINS = {
    zod: "4.3.6",
    react: "19.2.5",
    reactDom: "19.2.5",
    typescript: "5.9.3",
    reactTypes: "19.2.14",
    reactDomTypes: "19.2.3",
    mdxTypes: "2.0.13",
    nodeTypes: "25.6.0",
    // The DDD UI uses the canonical Milkdown editor; former graph UI runtime
    // dependencies are no longer part of the default pack.
    milkdownCrepe: "7.21.2",
    // DDD renders Mermaid fenced diagrams in its markdown preview.
    mermaid: "11.12.1",
};
/**
 * @returns {DependencyVersions}
 */
function readDependencyVersions() {
    return {
        smithersVersion: readOwnPackageVersion(),
        zodVersion: resolveInstalledPackageVersion("zod", BUNDLED_VERSION_PINS.zod),
        reactVersion: resolveInstalledPackageVersion("react", BUNDLED_VERSION_PINS.react),
        reactDomVersion: resolveInstalledPackageVersion("react-dom", BUNDLED_VERSION_PINS.reactDom),
        typescriptVersion: resolveInstalledPackageVersion("typescript", BUNDLED_VERSION_PINS.typescript),
        reactTypesVersion: resolveInstalledPackageVersion("@types/react", BUNDLED_VERSION_PINS.reactTypes),
        reactDomTypesVersion: resolveInstalledPackageVersion("@types/react-dom", BUNDLED_VERSION_PINS.reactDomTypes),
        mdxTypesVersion: resolveInstalledPackageVersion("@types/mdx", BUNDLED_VERSION_PINS.mdxTypes),
        nodeTypesVersion: resolveInstalledPackageVersion("@types/node", BUNDLED_VERSION_PINS.nodeTypes),
        milkdownCrepeVersion: resolveInstalledPackageVersion("@milkdown/crepe", BUNDLED_VERSION_PINS.milkdownCrepe),
        mermaidVersion: resolveInstalledPackageVersion("mermaid", BUNDLED_VERSION_PINS.mermaid),
    };
}
/**
 * @param {DependencyVersions} versions
 */
function renderPackageJson(versions) {
    const smithersSpec = versions.smithersVersion
        ? `^${versions.smithersVersion}`
        : FALLBACK_SMITHERS_SPEC;
    return JSON.stringify({
        name: "smithers-workflows",
        private: true,
        type: "module",
        scripts: {
            typecheck: "tsc --noEmit",
            gateway: "bun ./gateway.ts",
            "workflow:list": "smithers workflow list",
            "workflow:run": "smithers workflow run",
            "workflow:implement": "smithers workflow implement",
            "workflow:inspect": "smithers workflow inspect",
            "workflow:skills": "smithers workflow skills",
        },
        dependencies: {
            react: versions.reactVersion,
            "react-dom": versions.reactDomVersion,
            "smithers-orchestrator": smithersSpec,
            // The seeded `init` system workflow imports the CLI's pack
            // scaffolding functions to make re-init a durable run.
            "@smithers-orchestrator/cli": smithersSpec,
            zod: versions.zodVersion,
            "@milkdown/crepe": versions.milkdownCrepeVersion,
            mermaid: versions.mermaidVersion,
        },
        devDependencies: {
            typescript: versions.typescriptVersion,
            "@types/react": versions.reactTypesVersion,
            "@types/react-dom": versions.reactDomTypesVersion,
            "@types/mdx": versions.mdxTypesVersion,
            "@types/node": versions.nodeTypesVersion,
        },
    }, null, 2) + "\n";
}
function renderTsconfig() {
    return JSON.stringify({
        compilerOptions: {
            lib: ["ESNext", "DOM", "DOM.Iterable"],
            target: "ESNext",
            module: "ESNext",
            moduleDetection: "force",
            jsx: "react-jsx",
            jsxImportSource: "smithers-orchestrator",
            moduleResolution: "bundler",
            allowImportingTsExtensions: true,
            verbatimModuleSyntax: true,
            noEmit: true,
            strict: true,
            skipLibCheck: true,
            // No baseUrl: TS 6 deprecates it (TS5101) and `paths` resolves
            // relative to this tsconfig without it.
            paths: {
                "~/*": ["./*"],
            },
        },
        include: ["./**/*"],
        exclude: ["./executions/**/*"],
    }, null, 2) + "\n";
}
/**
 * Component dependency manifest — each component's direct deps.
 * @type {Record<string, { components: string[]; prompts: string[] }>}
 */
/**
 * @typedef {{ id: string; ui: string; seeded?: boolean; system?: boolean }} WorkflowManifestEntry
 */
/**
 * Single source of truth for every installable workflow — its UI key, the
 * components it directly uses, and the prompts from renderPrompts() it imports.
 * Seeded workflows live in GENERATED_SEEDED_FILES; their prompts are bundled
 * inside that array and are filtered via path-prefix matching.
 * @type {WorkflowManifestEntry[]}
 */
const WORKFLOW_MANIFEST = [
    // The curated user-facing init pack. Their sources and transitive files are
    // emitted by the generator; no legacy starter suite is hidden here.
    { id: "create-workflow", ui: "create-workflow", seeded: true },
    { id: "create-skill", ui: "create-skill", seeded: true },
    { id: "docs-driven-development", ui: "docs-driven-development", seeded: true },
    // System workflow: durable `smithers init` (hidden from default listings).
    { id: "init", ui: "init", seeded: true, system: true },
    // System workflow: auto-launched autopsy for failed runs.
    { id: "post-failure", ui: "post-failure", seeded: true, system: true },
    // System workflow: agent-assisted Smithers CLI/plugin/package upgrade.
    { id: "upgrade", ui: "upgrade", seeded: true, system: true },
];
/**
 * The IDs of every installable workflow, in manifest order. System workflows
 * (durable `init`, `post-failure` autopsy, `upgrade`) are internal plumbing the pack
 * closure always installs — they are never offered in the interactive wizard
 * and never subject to à-la-carte deselection — so they are excluded unless
 * `includeSystem: true` is passed. Exported so the init wizard derives its
 * option list from this single source of truth instead of a hand-kept copy.
 *
 * @param {{ includeSystem?: boolean }} [opts]
 * @returns {string[]}
 */
export function workflowManifestIds(opts = {}) {
    return WORKFLOW_MANIFEST
        .filter((w) => opts.includeSystem || !w.system)
        .map((w) => w.id);
}
/**
 * Compute the transitive closure of components and prompts needed by the
 * selected workflows. Defaults to all workflows when selectedWorkflows is
 * undefined (byte-identical to today's output).
 *
 * @param {string[] | undefined} selectedWorkflows
 * @returns {{ workflowIds: Set<string> }}
 */
function computeClosure(selectedWorkflows) {
    const allIds = WORKFLOW_MANIFEST.map((w) => w.id);
    // System workflows (durable `init`, `post-failure`, `upgrade`) are always installed
    // regardless of the caller's selection: the wizard never offers them and
    // an à-la-carte selection must not drop them (else durable re-init and the
    // failure autopsy silently stop working). Force-include them here rather
    // than trusting every caller to remember.
    const systemIds = WORKFLOW_MANIFEST.filter((w) => w.system).map((w) => w.id);
    const workflowIds = new Set([...(selectedWorkflows ?? allIds), ...systemIds]);
    return { workflowIds };
}
/**
 * Filter GENERATED_SEEDED_FILES to only include files owned by a selected
 * seeded workflow. Generated entries with explicit `owners` (lib helpers)
 * install only alongside a workflow that imports them; otherwise each seeded
 * workflow owns its .tsx file and any prompt whose path starts with
 * `.smithers/prompts/<id>` (exact or `<id>-*`).
 *
 * @param {TemplateFile[]} files
 * @param {Set<string>} workflowIds
 * @returns {TemplateFile[]}
 */
function filterSeededFiles(files, workflowIds) {
    // Sort seeded IDs longest-first to resolve prefix ambiguity
    // (e.g. "research-plan-implement" before "research").
    const seededIds = WORKFLOW_MANIFEST
        .filter((w) => w.seeded)
        .map((w) => w.id)
        .sort((a, b) => b.length - a.length);
    return files.filter((f) => {
        if (Array.isArray(f.owners) && f.owners.length > 0) {
            return f.owners.some((id) => workflowIds.has(id));
        }
        if (f.path.startsWith(".smithers/workflows/")) {
            const id = f.path.replace(".smithers/workflows/", "").replace(/\.tsx$/, "");
            return workflowIds.has(id);
        }
        if (f.path.startsWith(".smithers/prompts/")) {
            const promptId = f.path.replace(".smithers/prompts/", "").replace(/\.mdx$/, "");
            const owner = seededIds.find(
                (id) => promptId === id || promptId.startsWith(id + "-"),
            );
            return owner !== undefined && workflowIds.has(owner);
        }
        if (f.path.startsWith(".smithers/lib/")) {
            // A `.smithers/lib/*` helper ships only when a SELECTED seeded
            // workflow actually imports it. Attribution is by real import edge,
            // not a name prefix: a lib file's name need not match its importer
            // (e.g. ddd-bug-scan imports ../lib/ddd/dddRoot.ts).
            const rel = f.path.replace(".smithers/lib/", "");
            const specForms = [rel, rel.replace(/\.tsx?$/, ""), rel.replace(/\/index\.tsx?$/, "")];
            return files.some((wf) => {
                if (!wf.path.startsWith(".smithers/workflows/")) return false;
                const wfId = wf.path.replace(".smithers/workflows/", "").replace(/\.tsx$/, "");
                if (!workflowIds.has(wfId)) return false;
                return specForms.some((spec) =>
                    wf.contents.includes(`../lib/${spec}"`) || wf.contents.includes(`../lib/${spec}'`),
                );
            });
        }
        return true;
    });
}
/**
 * @param {{ scaffoldCustomAgent?: boolean }} [options]
 * @returns {TemplateFile[]}
 */
function renderAgentScaffoldFiles(options = {}) {
    const files = [
        {
            path: ".smithers/agents/claude-code.ts",
            preserveExisting: true,
            contents: [
                'import { ClaudeCodeAgent as SmithersClaudeCodeAgent } from "smithers-orchestrator";',
                "",
                '// Built-in Claude Code CLI agent (cliEngine: "claude-code").',
                "// Tweak `model` or uncomment extra options below to match your setup.",
                "export const ClaudeCodeAgent = new SmithersClaudeCodeAgent({",
                '  model: "claude-fable-5",',
                '  // systemPrompt: "Add shared instructions for every Claude run.",',
                "  // timeoutMs: 10 * 60 * 1000,",
                "  // dangerouslySkipPermissions: true,",
                "});",
                "",
            ].join("\n"),
        },
        {
            path: ".smithers/agents/codex.ts",
            preserveExisting: true,
            contents: [
                'import { CodexAgent as SmithersCodexAgent } from "smithers-orchestrator";',
                "",
                '// Built-in Codex CLI agent (cliEngine: "codex").',
                "// Tweak `model` or uncomment extra options below to match your setup.",
                "export const CodexAgent = new SmithersCodexAgent({",
                '  model: "gpt-5.6-luna",',
                '  config: { model_reasoning_effort: "medium" },',
                "  skipGitRepoCheck: true,",
                '  // systemPrompt: "Add shared instructions for every Codex run.",',
                '  // sandbox: "workspace-write",',
                "  // fullAuto: true,",
                "});",
                "",
            ].join("\n"),
        },
        {
            path: ".smithers/agents/opencode.ts",
            preserveExisting: true,
            contents: [
                'import { OpenCodeAgent as SmithersOpenCodeAgent } from "smithers-orchestrator";',
                "",
                '// Built-in OpenCode CLI agent (cliEngine: "opencode").',
                "// Tweak `model` or uncomment extra options below to match your setup.",
                "export const OpenCodeAgent = new SmithersOpenCodeAgent({",
                '  model: "anthropic/claude-fable-5",',
                '  // agentName: "build",',
                '  // systemPrompt: "Add shared instructions for every OpenCode run.",',
                "  // yolo: true,",
                "});",
                "",
            ].join("\n"),
        },
        {
            path: ".smithers/agents/antigravity.ts",
            preserveExisting: true,
            contents: [
                'import { AntigravityAgent as SmithersAntigravityAgent } from "smithers-orchestrator";',
                "",
                '// Built-in Antigravity CLI agent (cliEngine: "antigravity").',
                "// Tweak `model` or uncomment extra options below to match your setup.",
                "export const AntigravityAgent = new SmithersAntigravityAgent({",
                '  // model: "Gemini 3.1 Pro (high)",',
                '  // systemPrompt: "Add shared instructions for every Antigravity run.",',
                "  // dangerouslySkipPermissions: true,",
                '  // allowedTools: ["read_file", "write_file"],',
                "});",
                "",
            ].join("\n"),
        },
        {
            path: ".smithers/agents/index.ts",
            preserveExisting: true,
            contents: [
                'export { ClaudeCodeAgent } from "./claude-code";',
                'export { CodexAgent } from "./codex";',
                'export { OpenCodeAgent } from "./opencode";',
                'export { AntigravityAgent } from "./antigravity";',
                ...(options.scaffoldCustomAgent ? ['export { CustomAgent } from "./custom";'] : []),
                "",
            ].join("\n"),
        },
        {
            path: ".smithers/agents/README.md",
            preserveExisting: true,
            contents: [
                "# Agent Config",
                "",
                "These files export the configured agent instances used by your Smithers workflows.",
                "",
                "- `claude-code.ts`, `codex.ts`, `opencode.ts`, and `antigravity.ts` are user-owned config.",
                "- Edit them to pin models, set `cwd`, add a shared `systemPrompt`, or enable engine-specific flags.",
                "- `index.ts` re-exports all four so root-level files can import from `./agents`.",
                "",
                "Examples:",
                "",
                "```ts",
                'import { ClaudeCodeAgent } from "./agents";',
                'import { CodexAgent } from "./agents/codex";',
                'import { OpenCodeAgent } from "./agents/opencode";',
                'import { AntigravityAgent } from "./agents/antigravity";',
                "```",
                "",
                "Inside `.smithers/workflows/*`, use `../agents` or `../agents/<name>` instead.",
                "",
                "`smithers init` and `smithers init --agents-only` only create missing files in this directory.",
                "Existing files here are left alone so your custom agent config is preserved.",
                "",
            ].join("\n"),
        },
    ];
    if (options.scaffoldCustomAgent) {
        files.splice(4, 0, {
            path: ".smithers/agents/custom.ts",
            preserveExisting: true,
            contents: [
                'import { type AgentLike } from "smithers-orchestrator";',
                "",
                "// Custom AgentLike adapter scaffold.",
                "// Implement generate(args) to run your provider/tool and return the assistant text.",
                "export const CustomAgent: AgentLike = {",
                "  async generate(args = {}) {",
                '    const prompt = typeof args === "object" && args && "prompt" in args',
                "      ? String((args as { prompt?: unknown }).prompt ?? \"\")",
                "      : String(args ?? \"\");",
                "    throw new Error(",
                '      "CustomAgent is scaffolded but not implemented. Replace generate(args) with your adapter; it must return the assistant text for: " + prompt,',
                "    );",
                "  },",
                "};",
                "",
            ].join("\n"),
        });
    }
    return files;
}
function renderGenericWorkflowUiSource(key) {
    return `/** @jsxImportSource react */
import { useState } from "react";
import { createGatewayReactRoot, useGatewayActions, useGatewayRuns } from "smithers-orchestrator/gateway-react";
const WORKFLOW_KEY = ${JSON.stringify(key)};
function App() {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const runsRaw = useGatewayRuns({ filter: { limit: 20 } });
  const runs = ((runsRaw.data ?? []) as Array<{ runId: string; workflowKey?: string; status?: string }>).filter((r) => !r.workflowKey || r.workflowKey === WORKFLOW_KEY);
  const actions = useGatewayActions();
  async function start() { setBusy(true); try { await actions.launchRun({ workflow: WORKFLOW_KEY, input: { prompt } }); } finally { setBusy(false); } }
  return <main style={{ fontFamily: "system-ui", background: "#0c0c0e", color: "#eee", minHeight: "100vh", padding: 20 }}>
    <h2>{WORKFLOW_KEY}</h2>
    <div style={{ display: "flex", gap: 8 }}><input value={prompt} onChange={(e) => setPrompt(e.currentTarget.value)} placeholder="Optional prompt…" /><button disabled={busy} onClick={() => void start()}>Start</button></div>
    <ul>{runs.map((run) => <li key={run.runId}>{run.runId.slice(0, 8)} — {run.status ?? "running"}</li>)}</ul>
  </main>;
}
createGatewayReactRoot(<App />);
`;
}
const UI_WORKFLOWS = [
    { key: "create-workflow", title: "Create Workflow" },
    { key: "create-skill", title: "Create Skill" },
    { key: "docs-driven-development", title: "Docs Driven Development" },
];
const SEEDED_UI_KEYS = new Set(["docs-driven-development"]);
function renderUiFiles(workflowIds) {
    return UI_WORKFLOWS
        .map((w) => w.key)
        .filter((key) => !workflowIds || workflowIds.has(key))
        .filter((key) => !SEEDED_UI_KEYS.has(key))
        .map((key) => ({
            path: `.smithers/ui/${key}.tsx`,
            contents: renderGenericWorkflowUiSource(key),
        }));
}

/** A safe JS identifier for a workflow key used in the generated gateway.ts. */
function toUiIdent(key) {
    const ident = key.replace(/[^a-zA-Z0-9]/g, "_");
    return /^[a-zA-Z_]/.test(ident) ? ident : `_${ident}`;
}

/**
 * @param {Set<string>} [workflowIds] - when provided, only mount selected workflows.
 */
function renderGatewayFile(workflowIds) {
    const workflows = workflowIds ? UI_WORKFLOWS.filter((w) => workflowIds.has(w.key)) : UI_WORKFLOWS;
    const mounts = workflows.map(
        (w) => `await mountWorkflow(${JSON.stringify(w.key)}, ${JSON.stringify(w.title)});`,
    );
    return {
        path: ".smithers/gateway.ts",
        contents: [
            'import { Gateway, mdxPlugin } from "smithers-orchestrator";',
            'import { dirname, resolve } from "node:path";',
            'import { fileURLToPath } from "node:url";',
            "",
            "mdxPlugin();",
            "",
            "const here = dirname(fileURLToPath(import.meta.url));",
            "const projectRoot = resolve(here, \"..\");",
            "process.chdir(projectRoot);",
            "",
            "const parsedPort = Number(process.env.PORT ?? \"7331\");",
            "const port = Number.isInteger(parsedPort) && parsedPort > 0 ? parsedPort : 7331;",
            "const host = process.env.HOST ?? \"127.0.0.1\";",
            "",
            "const gateway = new Gateway({ heartbeatMs: 15_000 });",
            "",
            "// Mount each workflow independently. Browser UIs are declared by each workflow",
            "// with <UI entry=\"../ui/<key>.tsx\" /> and discovered by Gateway.register().",
            "// A workflow that fails to import (e.g. a broken prompt/MDX) disables only itself — the rest of",
            "// the gateway and the other workflow UIs still come up.",
            "async function mountWorkflow(key: string, title: string) {",
            "  try {",
            "    const workflowEntry = resolve(here, \"workflows\", key + \".tsx\");",
            "    const mod = await import(\"./workflows/\" + key + \".tsx\");",
            "    gateway.register(key, mod.default, { entryFile: workflowEntry });",
            "    const mounted = (gateway as any).workflows?.get?.(key)?.ui;",
            "    if (mounted) {",
            "      console.log(\"  \" + title + \" UI -> http://\" + host + \":\" + port + \"/workflows/\" + key);",
            "    } else {",
            "      console.log(\"  \" + title + \" (no UI)\");",
            "    }",
            "  } catch (err) {",
            "    const message = err instanceof Error ? err.message : String(err);",
            "    console.warn(\"[gateway] skipped \" + key + \": \" + message);",
            "  }",
            "}",
            "",
            "console.log(\"Workflow UIs:\");",
            ...mounts,
            "",
            "await gateway.listen({ host, port });",
            "console.log(\"Smithers Gateway listening on http://\" + host + \":\" + port);",
            "",
        ].join("\n"),
    };
}
// Legacy bespoke pack UIs were moved to examples/init-pack.
/**
 * Legacy inline workflows are no longer part of the init pack. They live in
 * examples/init-pack/ and are intentionally not rendered here.
 */
function renderTemplateFiles(versions, env, projectRoot, closure, options = {}) {
    const { workflowIds } = closure;
    return [
        { path: ".smithers/.gitignore", contents: "node_modules/\nexecutions/\nruns/\nreports/\nsandboxes/\nstate\ntmp\n*.db\n*.sqlite\npg/\n" },
        { path: ".smithers/workflows/.gitignore", contents: "*.log\nrun-*.log\n" },
        { path: ".smithers/package.json", contents: renderPackageJson(versions) },
        { path: ".smithers/tsconfig.json", contents: renderTsconfig() },
        { path: ".smithers/types/assets.d.ts", contents: 'declare module "*.md" { const Component: any; export default Component; }\ndeclare module "*.mdx" { const Component: any; export default Component; }\n' },
        { path: ".smithers/bunfig.toml", contents: 'preload = ["./preload.ts"]\n' },
        { path: ".smithers/preload.ts", contents: 'import { mdxPlugin } from "smithers-orchestrator";\nmdxPlugin();\n' },
        renderGatewayFile(workflowIds),
        ...renderAgentScaffoldFiles({ scaffoldCustomAgent: options.scaffoldCustomAgent }),
        { path: ".smithers/agents.ts", contents: generateAgentsTs(env, { cwd: projectRoot }) },
        { path: ".smithers/smithers.config.ts", contents: "export const repoCommands = { lint: null, test: null, coverage: null } as const;\nexport default { repoCommands };\n" },
        ...filterSeededFiles(GENERATED_SEEDED_FILES, workflowIds),
        ...renderUiFiles(workflowIds),
        { path: ".smithers/skills/.gitkeep", contents: "" },
        { path: ".smithers/tickets/.gitkeep", contents: "" },
    ];
}
/**
 * Agent doc filenames that can receive the smithers-workflow guidance block.
 * Mirrors DEFAULT_FILE_NAMES in noteWorkflowPreferenceInAgentDocs.js; used to
 * reconstruct the honored allowlist from a persisted deselection.
 * @type {string[]}
 */
const AGENT_DOC_FILE_NAMES = ["CLAUDE.md", "AGENTS.md"];

/**
 * Pack-local marker recording which workflows / agent docs the user deselected
 * during an interactive `smithers init`, so a later NON-interactive re-init
 * (agent-run `init --yes`, the durable `init` workflow, CI) does not silently
 * re-add them. Mirrors the skill-deselection marker (installCuratedSkill.js).
 *
 * It lives at the pack root and is written OUTSIDE `templateFiles`, so `--force`
 * (which only rewrites bundled templates) never clobbers it. A missing or empty
 * marker means "install every workflow", keeping existing packs unchanged.
 */
const PACK_SELECTIONS_FILE = "pack-selections.json";

/** @param {string} rootDir */
function packSelectionsPath(rootDir) {
    return resolve(rootDir, PACK_SELECTIONS_FILE);
}

/**
 * Read the persisted à-la-carte deselection for the pack at `rootDir`.
 * Exported so the interactive init wizard seeds its checkboxes from what the
 * user chose last time instead of re-checking everything (which would persist
 * as "select all" on confirm and silently wipe the earlier opt-outs).
 * @param {string} rootDir
 * @returns {{ deselectedWorkflows: string[]; deselectedAgentDocs: string[] }}
 */
export function loadPackSelections(rootDir) {
    try {
        const parsed = JSON.parse(readFileSync(packSelectionsPath(rootDir), "utf8"));
        return {
            deselectedWorkflows: Array.isArray(parsed.deselectedWorkflows) ? parsed.deselectedWorkflows : [],
            deselectedAgentDocs: Array.isArray(parsed.deselectedAgentDocs) ? parsed.deselectedAgentDocs : [],
        };
    } catch {
        return { deselectedWorkflows: [], deselectedAgentDocs: [] };
    }
}

/**
 * @param {string} rootDir
 * @param {{ deselectedWorkflows: string[]; deselectedAgentDocs: string[] }} selections
 */
function savePackSelections(rootDir, selections) {
    try {
        writeFileSync(packSelectionsPath(rootDir), `${JSON.stringify(selections, null, 2)}\n`, "utf8");
    } catch {
        /* best-effort: a persistence failure must never block init */
    }
}

/**
 * Reconstruct the honored agent-doc allowlist from a persisted deselection.
 * Returns `undefined` when nothing was deselected (meaning "all agent docs"), so
 * the result passes straight through to `noteWorkflowPreferenceInAgentDocs`'s
 * optional `fileNames` (undefined = its default of both docs).
 * @param {string[]} deselectedAgentDocs
 * @returns {string[] | undefined}
 */
function survivingAgentDocs(deselectedAgentDocs) {
    if (!deselectedAgentDocs || deselectedAgentDocs.length === 0) return undefined;
    const deselected = new Set(deselectedAgentDocs.map((name) => name.toLowerCase()));
    return AGENT_DOC_FILE_NAMES.filter((name) => !deselected.has(name.toLowerCase()));
}

/**
 * Which agent-doc filenames (CLAUDE.md / AGENTS.md) still opt in to the
 * workflow-guidance block for the pack at `rootDir`, honoring the à-la-carte
 * deselection persisted in `pack-selections.json`. Exported so the durable
 * `init` workflow — whose `note-agent-docs` task calls
 * `noteWorkflowPreferenceInAgentDocs` directly, outside `initWorkflowPack`'s
 * `installSkill` block — does not re-add guidance to a doc the user opted out of
 * during an interactive init. Returns `undefined` when nothing was deselected.
 * @param {string} rootDir  Pack root (the `.smithers` dir) holding pack-selections.json
 * @returns {string[] | undefined}
 */
export function resolveEffectiveAgentDocs(rootDir) {
    return survivingAgentDocs(loadPackSelections(rootDir).deselectedAgentDocs);
}

/**
 * Run-store files smithers creates in the PROJECT root (not under `.smithers/`,
 * whose own scaffolded `.gitignore` already covers everything inside it). The
 * sqlite workspace db lands next to the pack, so without this a brand-new
 * user's `git status` fills with `smithers.db*` after their first run.
 */
const ROOT_GITIGNORE_MARKER = "# Smithers run store (ephemeral — never commit)";
const ROOT_GITIGNORE_ENTRIES = ["smithers.db", "smithers.db-shm", "smithers.db-wal"];

/**
 * Ensure the project root `.gitignore` covers the run-store files smithers
 * writes next to `.smithers/`. Idempotent: appends one marker block, and only
 * when the repo (git or jj) doesn't already ignore `smithers.db`. Best-effort —
 * a failure here never blocks init.
 *
 * @param {string} projectRoot
 * @returns {RootGitignoreResult}
 */
export function ensureRootGitignore(projectRoot) {
    const gitignorePath = resolve(projectRoot, ".gitignore");
    try {
        if (!existsSync(resolve(projectRoot, ".git")) && !existsSync(resolve(projectRoot, ".jj"))) {
            return { status: "skipped", path: gitignorePath, reason: "not a git/jj repository" };
        }
        let current = "";
        if (existsSync(gitignorePath)) {
            current = readFileSync(gitignorePath, "utf8");
            // Respect an existing rule (exact entry, our marker, or a broad *.db).
            if (current.includes(ROOT_GITIGNORE_MARKER) ||
                /^\s*\*?\.?\/?smithers\.db\*?\s*$/m.test(current) ||
                /^\s*\*\.db\s*$/m.test(current)) {
                return { status: "unchanged", path: gitignorePath };
            }
        }
        const block = `${ROOT_GITIGNORE_MARKER}\n${ROOT_GITIGNORE_ENTRIES.join("\n")}\n`;
        const next = current.length === 0
            ? block
            : `${current}${current.endsWith("\n") ? "" : "\n"}\n${block}`;
        writeFileSync(gitignorePath, next, "utf8");
        return { status: current.length === 0 ? "created" : "updated", path: gitignorePath };
    }
    catch (err) {
        return { status: "skipped", path: gitignorePath, reason: err?.message ?? String(err) };
    }
}

/**
 * @param {InitOptions} [options]
 * @returns {InitResult}
 */
export function initWorkflowPack(options = {}) {
    const projectRoot = options.rootDir ?? process.cwd();
    // Tests inject a seeded env (fake agent on PATH + provider key) so in-process
    // init works on CI, which has no agent CLIs/credentials. Defaults to the real
    // process env for normal use.
    const env = options.env ?? process.env;
    // Local packs live at `<repo>/.smithers`; the global pack IS the canonical
    // `~/.smithers` (honoring SMITHERS_HOME) — no nested `.smithers` segment. The
    // template paths below are all `.smithers/…`-prefixed, so we strip that prefix
    // and write relative to the pack dir, making the local case byte-identical.
    const rootDir = options.global ? accountsRoot(env) : resolve(projectRoot, ".smithers");
    const writtenFiles = [];
    const skippedFiles = [];
    const preservedPaths = [];
    // Pack files that exist on disk but differ from the latest bundled template
    // (non-preserve files skipped on a default, non-force run). The interactive
    // `init` ceremony offers these for selective update; other callers just see
    // them in the result. Enriched with shared-component impact for the warning.
    const changedFiles = [];
    // Honor a persisted à-la-carte deselection when the caller didn't pass an
    // explicit selection. Non-interactive re-init and the durable `init`
    // workflow both call with selectedWorkflows/selectedAgentDocs === undefined
    // (defaulting to "everything"); without this they would re-add a workflow
    // or agent-doc the user opted out of during an interactive init.
    const persisted = options.agentsOnly ? { deselectedWorkflows: [], deselectedAgentDocs: [] } : loadPackSelections(rootDir);
    let effectiveSelectedWorkflows = options.selectedWorkflows;
    if (effectiveSelectedWorkflows === undefined && persisted.deselectedWorkflows.length > 0) {
        const deselected = new Set(persisted.deselectedWorkflows);
        effectiveSelectedWorkflows = workflowManifestIds({ includeSystem: false }).filter((id) => !deselected.has(id));
    }
    let effectiveAgentDocs = options.selectedAgentDocs;
    if (effectiveAgentDocs === undefined) {
        effectiveAgentDocs = survivingAgentDocs(persisted.deselectedAgentDocs);
    }
    ensureDir(rootDir);
    ensureDir(resolve(rootDir, "agents"));
    /** @type {TemplateFile[]} */
    let templateFiles;
    if (options.agentsOnly) {
        templateFiles = renderAgentScaffoldFiles({ scaffoldCustomAgent: options.scaffoldCustomAgent });
    }
    else {
        const versions = readDependencyVersions();
        ensureDir(resolve(rootDir, "prompts"));
        ensureDir(resolve(rootDir, "components"));
        ensureDir(resolve(rootDir, "ui"));
        ensureDir(resolve(rootDir, "workflows"));
        ensureDir(resolve(rootDir, "tickets"));
        const executionsDir = resolve(rootDir, "executions");
        if (existsSync(executionsDir)) {
            preservedPaths.push(executionsDir);
        }
        else {
            ensureDir(executionsDir);
        }
        const closure = computeClosure(effectiveSelectedWorkflows);
        templateFiles = renderTemplateFiles(versions, env, projectRoot, closure, {
            scaffoldCustomAgent: options.scaffoldCustomAgent,
        });
    }
    const importerMap = buildComponentImporterMap(templateFiles);
    for (const file of templateFiles) {
        const absolutePath = resolve(rootDir, file.path.replace(/^\.smithers\//, ""));
        ensureParent(absolutePath);
        if (existsSync(absolutePath) && (file.preserveExisting || !options.force)) {
            skippedFiles.push(absolutePath);
            if (file.preserveExisting) {
                if (options.reporter) options.reporter.onSkip?.(file.path);
                else process.stderr.write(`[smithers:init] ${file.path} skipped: already exists\n`);
            }
            else {
                // A shippable (non-preserve) pack file that already exists and is
                // being skipped on this run. If its content drifted from the
                // bundled template, record it as an updatable candidate.
                let current;
                try {
                    current = readFileSync(absolutePath, "utf8");
                }
                catch {
                    current = undefined;
                }
                if (current !== undefined && current !== file.contents) {
                    const component = componentBaseName(file.path);
                    changedFiles.push({
                        path: file.path,
                        absolutePath,
                        contents: file.contents,
                        isComponent: component !== null,
                        importedBy: component ? (importerMap.get(component) ?? []) : [],
                    });
                }
            }
            continue;
        }
        writeFileSync(absolutePath, file.contents, "utf8");
        writtenFiles.push(absolutePath);
    }
    options.reporter?.scaffolded?.({
        writtenCount: writtenFiles.length,
        skippedCount: skippedFiles.length,
        preservedCount: preservedPaths.length,
    });
    // Keep the user's repo clean: the run store (smithers.db*) is written to the
    // project root, outside `.smithers/`'s own .gitignore. Local packs only —
    // a global (~/.smithers) init has no project repo to protect.
    let gitignore;
    if (!options.agentsOnly && !options.global) {
        gitignore = ensureRootGitignore(projectRoot);
        options.reporter?.gitignoreEnsured?.(gitignore);
    }
    // Drop the curated `smithers` skill into each detected coding agent so the
    // user never hand-runs mkdir + curl. Opt-in (the CLI `init` command sets it):
    // direct callers and tests default to off so they don't write to ~/.
    let skill;
    if (options.installSkill && !options.agentsOnly) {
        const homeDir = options.skillOptions?.homeDir ?? env.HOME ?? homedir();
        // Non-interactive callers (selectedSkillTargets === undefined, e.g.
        // `init --yes` / CI) install to all detected agents, but must still HONOR
        // a persisted deselection — otherwise a re-run silently re-adds a skill
        // the user opted out of, which refreshCuratedSkills then freezes as stale
        // (marker says opted-out, so it is never refreshed). Filtering by the
        // marker keeps disk and marker consistent; an empty marker = install all.
        let targets = options.selectedSkillTargets;
        if (targets === undefined) {
            const optedOut = new Set(loadSkillDeselections(homeDir));
            if (optedOut.size > 0) {
                targets = skillTargets(homeDir).map((t) => t.id).filter((id) => !optedOut.has(id));
            }
        }
        const skillOpts = {
            ...options.skillOptions,
            ...(targets ? { targets } : {}),
        };
        skill = installCuratedSkill(skillOpts);
        options.reporter?.skillInstalled?.(skill);
        // Persist which agents the user deselected so refreshCuratedSkills does
        // not re-add them on upgrade. Only write the marker when the caller
        // passed an explicit selection (undefined = non-interactive, which honors
        // the existing marker above rather than rewriting it).
        if (options.selectedSkillTargets !== undefined) {
            const allIds = skillTargets(homeDir).map((t) => t.id);
            const deselectedIds = allIds.filter((id) => !options.selectedSkillTargets.includes(id));
            try {
                saveSkillDeselections(homeDir, deselectedIds);
            } catch {
                /* best-effort */
            }
        }
    }
    // If the repo already keeps a CLAUDE.md / AGENTS.md, append guidance on when
    // to reach for durable smithers.sh workflows over plain subagents. Gated with
    // the skill install so a single `--no-skill` opts out of every mutation
    // smithers makes to the agent's instructions; idempotent and only ever
    // appends to files that already exist.
    let agentDocs;
    if (options.installSkill && !options.agentsOnly) {
        agentDocs = noteWorkflowPreferenceInAgentDocs({
            projectRoot,
            ...(effectiveAgentDocs ? { fileNames: effectiveAgentDocs } : {}),
        });
        options.reporter?.agentDocsNoted?.(agentDocs);
    }
    // Persist the à-la-carte workflow / agent-doc deselection so a later
    // non-interactive re-init (or the durable `init` workflow) does not re-add
    // what the user opted out of. Only write when the caller passed an explicit
    // selection (the interactive ceremony does); an undefined selection is
    // non-interactive and HONORS the marker above rather than rewriting it.
    if (!options.agentsOnly && (options.selectedWorkflows !== undefined || options.selectedAgentDocs !== undefined)) {
        const deselectedWorkflows = options.selectedWorkflows !== undefined
            ? workflowManifestIds({ includeSystem: false }).filter((id) => !options.selectedWorkflows.includes(id))
            : persisted.deselectedWorkflows;
        const selectedDocs = options.selectedAgentDocs?.map((name) => name.toLowerCase());
        const deselectedAgentDocs = selectedDocs !== undefined
            ? AGENT_DOC_FILE_NAMES.filter((name) => !selectedDocs.includes(name.toLowerCase()))
            : persisted.deselectedAgentDocs;
        savePackSelections(rootDir, { deselectedWorkflows, deselectedAgentDocs });
    }
    const install = options.agentsOnly
        ? { status: "skipped", reason: "agents-only" }
        : runBunInstall(rootDir, options.skipInstall ?? false, options.reporter);
    return {
        rootDir,
        writtenFiles,
        skippedFiles,
        preservedPaths,
        changedFiles,
        install,
        ...(skill ? { skill } : {}),
        ...(agentDocs ? { agentDocs } : {}),
        ...(gitignore ? { gitignore } : {}),
    };
}

/**
 * Write the selected changed pack files to disk. Used by the interactive `init`
 * ceremony after the user picks which drifted pack files to update; each entry
 * is a {@link initWorkflowPack} `changedFiles` item.
 *
 * @param {Array<{ absolutePath: string; contents: string }>} entries
 * @returns {string[]} the absolute paths written
 */
export function applyWorkflowPackUpdates(entries) {
    const written = [];
    for (const entry of entries) {
        ensureParent(entry.absolutePath);
        writeFileSync(entry.absolutePath, entry.contents, "utf8");
        written.push(entry.absolutePath);
    }
    return written;
}
/**
 * Symlink the monorepo's packages/smithers into the pack's node_modules so a
 * local source checkout dogfoods the in-repo runtime instead of the
 * npm-installed one.
 * @param {string} rootDir
 */
function linkLocalSourceRuntime(rootDir) {
    if (!isLocalSourceCheckout()) return;
    const nodeModules = resolve(rootDir, "node_modules");
    if (!existsSync(nodeModules)) return;
    const runtimeLink = resolve(nodeModules, "smithers-orchestrator");
    rmSync(runtimeLink, { recursive: true, force: true });
    symlinkSync(SOURCE_SMITHERS_PACKAGE, runtimeLink, "dir");
}
/**
 * Install `.smithers/` workspace deps so the first workflow run isn't blocked
 * on a cold install. Failures here don't fail init: the scaffold is on disk,
 * the user can always re-run `bun install` by hand.
 *
 * When a reporter is supplied (the interactive `init` ceremony), bun's output
 * is captured instead of inherited so the flow stays clean; the captured tail
 * is handed back on failure. Without a reporter (piped/agent runs) the install
 * inherits stdio exactly as before.
 *
 * @param {string} rootDir
 * @param {boolean} skip
 * @param {InitReporter} [reporter]
 * @returns {InitInstallResult}
 */
function runBunInstall(rootDir, skip, reporter) {
    if (skip) return { status: "skipped", reason: "skip-install" };
    reporter?.installStart?.();
    const quiet = Boolean(reporter);
    const result = spawnSync("bun", ["install"], {
        cwd: rootDir,
        stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
        encoding: quiet ? "utf8" : undefined,
    });
    /** @type {InitInstallResult} */
    let installResult;
    if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
        installResult = {
            status: "failed",
            reason: "`bun` not found on PATH; run `bun install` inside .smithers/ manually",
        };
    }
    else if (result.status !== 0) {
        installResult = {
            status: "failed",
            reason: `bun install exited with status ${result.status ?? "unknown"}; run it manually inside .smithers/`,
        };
    }
    else {
        try {
            linkLocalSourceRuntime(rootDir);
            installResult = { status: "ok" };
        }
        catch (error) {
            installResult = {
                status: "failed",
                reason: `bun install completed, but linking the local source runtime failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
    }
    reporter?.installDone?.(installResult, quiet ? { stdout: result.stdout ?? "", stderr: result.stderr ?? "" } : undefined);
    return installResult;
}
/**
 * @param {string} workflowPath
 * @returns {WorkflowCta[]}
 */
export function getWorkflowFollowUpCtas(workflowPath) {
    return [];
}
