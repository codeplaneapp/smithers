import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { delimiter } from "node:path";
import {
  createExecutableDir,
  createTempRepo,
  runSmithers,
  writeFakeCodexBinary,
} from "../../../packages/smithers/tests/e2e-helpers.js";

const INIT_INSTALL_TIMEOUT_MS = 300_000;
const INIT_FAST_TIMEOUT_MS = 180_000;
/**
 * @param {string} homeDir
 */
function buildInitEnv(homeDir) {
  const binDir = createExecutableDir();
  writeFakeCodexBinary(binDir);
  return {
    HOME: homeDir,
    PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
    OPENAI_API_KEY: "sk-test-openai-key",
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
  };
}
/**
 * @param {TempRepo} repo
 */
function writeWorkflowPackTypecheckHarness(repo) {
  repo.write(
    ".smithers/types/e2e-shims.d.ts",
    ['declare module "*.mdx" {', "  const Component: any;", "  export default Component;", "}", ""].join("\n"),
  );
  repo.write(
    ".smithers/types/smithers-orchestrator.d.ts",
    [
      'declare module "smithers-orchestrator" {',
      "  export type AgentLike = any;",
      "  export type OutputTarget = any;",
      "  export type SmithersCtx<T = any> = any;",
      "  export const Workflow: any;",
      "  export const UI: any;",
      "  export const Task: any;",
      "  export const Sequence: any;",
      "  export const Parallel: any;",
      "  export const Panel: any;",
      "  export const Ralph: any;",
      "  export const Branch: any;",
      "  export const Loop: any;",
      "  export const Approval: any;",
      "  export const HumanTask: any;",
      "  export const ScanFixVerify: any;",
      "  export const DelegationChain: any;",
      "  export const delegationSchemas: any;",
      "  export const ContinueAsNew: any;",
      "  export const Sandbox: any;",
      "  export const Signal: any;",
      "  export const Timer: any;",
      "  export const WaitForEvent: any;",
      "  export const Worktree: any;",
      "  export const UI: any;",
      "  export const Gateway: any;",
      "  export const ClaudeCodeAgent: any;",
      "  export class CodexAgent { constructor(options?: any); generate(...args: any[]): any; }",
      "  export const OpenCodeAgent: any;",
      "  export const AntigravityAgent: any;",
      "  export const GeminiAgent: any;",
      "  export const KimiAgent: any;",
      "  export const tools: any;",
      "  export const read: any;",
      "  export const write: any;",
      "  export const edit: any;",
      "  export const grep: any;",
      "  export const bash: any;",
      "  export function createSmithers(...args: any[]): any;",
      "  export function executeChildWorkflow(...args: any[]): any;",
      "  export function defineTool(...args: any[]): any;",
      "  export function mdxPlugin(...args: any[]): any;",
      "}",
      "",
    ].join("\n"),
  );
  repo.write(
    ".smithers/types/smithers-orchestrator-jsx-runtime.d.ts",
    [
      'declare module "smithers-orchestrator/jsx-runtime" {',
      "  export const Fragment: any;",
      "  export function jsx(type: any, props: any, key?: any): any;",
      "  export function jsxs(type: any, props: any, key?: any): any;",
      "  export function jsxDEV(type: any, props: any, key?: any): any;",
      "}",
      "",
    ].join("\n"),
  );
  repo.write(
    ".smithers/types/smithers-orchestrator-gateway-react.d.ts",
    [
      'declare module "smithers-orchestrator/gateway-react" {',
      "  export const createGatewayReactRoot: any;",
      "  export function useGatewayActions(): any;",
      "  export function useGatewayApprovals(...args: any[]): any;",
      "  export function useGatewayNodeOutput(...args: any[]): any;",
      "  export function useGatewayRun(...args: any[]): any;",
      "  export function useGatewayRunEvents(...args: any[]): any;",
      "  export function useGatewayRuns(...args: any[]): any;",
      "  export function useGatewayRunTree(...args: any[]): any;",
      "  export function useGatewayTickets(...args: any[]): any;",
      "  export type UseGatewayRunTreeResult = { root: any; status?: string; isLoading: boolean; error?: unknown; };",
      "  export type DelegationNodeState = any;",
      "  // Structural, not `any`: Object.values() on an any-typed record",
      "  // yields unknown[] under TS 6, breaking property access in dc-graph.",
      "  export type DelegationGraph = {",
      "    nodes: Record<string, DelegationNodeState>;",
      "    edges: any[];",
      "    [key: string]: any;",
      "  };",
      "  export function useDelegationChain(...args: any[]): any;",
      "  export function foldDelegation(...args: any[]): any;",
      "}",
      "",
    ].join("\n"),
  );
  repo.write(
    ".smithers/types/smithers-orchestrator-gateway-ui.d.ts",
    [
      'declare module "smithers-orchestrator/gateway-ui" {',
      "  export const WorkflowUiShell: any;",
      "  export const WorkflowUiStyles: any;",
      "  export const workflowUiStyles: any;",
      "  export const SimpleWorkflowDashboard: any;",
      "  export const StatusPill: any;",
      "}",
      "",
    ].join("\n"),
  );
  // Seeded multi-file UI dependency declarations are browser-only coverage
  // inputs: the pack smoke typecheck doesn't install them, so declare their
  // imported surface as `any`, mirroring the smithers-orchestrator stubs above.
  // (Shorthand ambient modules are not enough: generic TYPE usage like
  // `Node<T>` needs explicit type declarations.)
  repo.write(
    ".smithers/types/seeded-ui-deps.d.ts",
    [
      'declare module "@xyflow/react" {',
      "  export type Node<T = any, K = any> = any;",
      "  export type Edge<T = any> = any;",
      "  export type NodeProps<T = any> = any;",
      "  export const Background: any;",
      "  export const Controls: any;",
      "  export const Handle: any;",
      "  export const Position: any;",
      "  export const ReactFlow: any;",
      "  export const ReactFlowProvider: any;",
      "  export function useReactFlow(): any;",
      "}",
      'declare module "@milkdown/crepe" {',
      "  export const Crepe: any;",
      "}",
      'declare module "mermaid" {',
      "  const mermaid: any;",
      "  export default mermaid;",
      "}",
      'declare module "dagre" {',
      "  const dagre: any;",
      "  export default dagre;",
      "}",
      "",
    ].join("\n"),
  );
  repo.write(
    ".smithers/types/smithers-orchestrator-ui.d.ts",
    [
      'declare module "smithers-orchestrator/ui" {',
      "  export const Button: any;",
      "  export const Card: any;",
      "  export const EmptyState: any;",
      "  export const Input: any;",
      "  export const RowButton: any;",
      "  export const SmithersUiStyles: any;",
      "  export const StatusPill: any;",
      "}",
      "",
    ].join("\n"),
  );
  repo.write(
    ".smithers/tsconfig.e2e.json",
    JSON.stringify(
      {
        extends: "./tsconfig.json",
        compilerOptions: {
          strict: false,
          noImplicitAny: false,
          ignoreDeprecations: "6.0",
          types: ["node", "react", "react-dom", "mdx"],
          paths: {
            "~/*": ["./*"],
            "smithers-orchestrator": ["./types/smithers-orchestrator.d.ts"],
            "smithers-orchestrator/gateway-react": ["./types/smithers-orchestrator-gateway-react.d.ts"],
            "smithers-orchestrator/gateway-ui": ["./types/smithers-orchestrator-gateway-ui.d.ts"],
            "smithers-orchestrator/ui": ["./types/smithers-orchestrator-ui.d.ts"],
            "smithers-orchestrator/jsx-runtime": ["./types/smithers-orchestrator-jsx-runtime.d.ts"],
          },
        },
        include: [
          "./agents.ts",
          "./agents/**/*.ts",
          "./preload.ts",
          "./gateway.ts",
          "./smithers.config.ts",
          "./types/**/*.d.ts",
          "./ui/**/*.ts",
          "./ui/**/*.tsx",
          "./workflows/**/*.ts",
          "./workflows/**/*.tsx",
        ],
        exclude: ["./executions/**/*"],
      },
      null,
      2,
    ) + "\n",
  );
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
    throw new Error(
      ["workflow-pack smoke typecheck failed", typecheck.stdout, typecheck.stderr].filter(Boolean).join("\n"),
    );
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
test(
  "smithers init writes the expected workflow-pack layout and it typechecks",
  () => {
    const repo = createTempRepo();
    const env = buildInitEnv(repo.dir);
    const result = runSmithers(["init"], {
      cwd: repo.dir,
      format: "json",
      env,
      timeoutMs: INIT_INSTALL_TIMEOUT_MS,
    });
    expect(result.exitCode).toBe(0);
    expect(repo.exists(".smithers/.gitignore")).toBe(true);
    // PGlite stores and migration receipts are local runtime state when present
    // and must never be committed, even though the clean default backend is SQLite.
    expect(repo.read(".smithers/.gitignore")).toContain("pg/");
    expect(repo.read(".smithers/.gitignore")).toContain("logs/");
    expect(repo.exists(".smithers/workflows/.gitignore")).toBe(true);
    expect(repo.exists(".smithers/package.json")).toBe(true);
    expect(repo.exists(".smithers/tsconfig.json")).toBe(true);
    expect(repo.exists(".smithers/bunfig.toml")).toBe(true);
    expect(repo.exists(".smithers/preload.ts")).toBe(true);
    expect(repo.exists(".smithers/gateway.ts")).toBe(true);
    expect(repo.exists(".smithers/agents.ts")).toBe(true);
    expect(repo.exists(".smithers/agents/claude-code.ts")).toBe(true);
    expect(repo.exists(".smithers/agents/codex.ts")).toBe(true);
    expect(repo.read(".smithers/agents/codex.ts")).toContain('model: "gpt-5.6-luna"');
    expect(repo.read(".smithers/agents/codex.ts")).toContain('config: { model_reasoning_effort: "medium" }');
    expect(repo.exists(".smithers/agents/opencode.ts")).toBe(true);
    expect(repo.exists(".smithers/agents/antigravity.ts")).toBe(true);
    expect(repo.exists(".smithers/agents/gemini.ts")).toBe(false);
    expect(repo.exists(".smithers/agents/index.ts")).toBe(true);
    expect(repo.exists(".smithers/agents/README.md")).toBe(true);
    for (const name of ["claude-code.ts", "codex.ts", "opencode.ts", "antigravity.ts"]) {
      expect(repo.read(`.smithers/agents/${name}`)).not.toContain("cwd: process.cwd()");
    }
    expect(repo.exists(".smithers/smithers.config.ts")).toBe(true);
    expect(repo.exists(".smithers/prompts/create-workflow-document.mdx")).toBe(true);
    expect(repo.exists(".smithers/ui/create-workflow.tsx")).toBe(true);
    expect(repo.exists(".smithers/ui/create-skill.tsx")).toBe(true);
    expect(repo.exists(".smithers/ui/docs-driven-development.tsx")).toBe(true);
    expect(repo.exists(".smithers/lib/ddd/build.ts")).toBe(true);
    expect(repo.exists(".smithers/skills/.gitkeep")).toBe(true);
    expect(repo.exists(".smithers/tickets/.gitkeep")).toBe(true);
    expect(repo.read(".smithers/workflows/create-workflow.tsx")).toContain("skillPath");
    expect(repo.read(".smithers/workflows/create-skill.tsx")).toContain("Skill");
    expect(repo.read(".smithers/workflows/docs-driven-development.tsx")).toContain("docs-driven-development");
    expect(repo.read(".smithers/workflows/init.tsx")).toContain("smithers-source: seeded");
    expect(repo.read(".smithers/gateway.ts")).toContain("process.chdir(projectRoot);");
    runWorkflowPackTypecheck(repo);
  },
  INIT_INSTALL_TIMEOUT_MS,
);
test(
  "smithers init --template keeps the curated scaffold and returns a create-workflow request",
  () => {
    const repo = createTempRepo();
    const env = buildInitEnv(repo.dir);
    const result = runSmithers(["init", "--template", "idea-to-tickets", "--no-install"], {
      cwd: repo.dir,
      format: "json",
      env,
      timeoutMs: INIT_FAST_TIMEOUT_MS,
    });
    expect(result.exitCode).toBe(0);
    expect(repo.exists(".smithers/workflows/create-workflow.tsx")).toBe(true);
    expect(repo.exists(".smithers/workflows/implement.tsx")).toBe(false);
    expect(result.json.template.id).toBe("idea-to-tickets");
    expect(result.json.template.workflow).toBe("create-workflow");
    expect(result.json.template.command).toStartWith("bunx smithers-orchestrator workflow run create-workflow --");
    expect(result.json.install).toMatchObject({
      reason: "skip-install",
      status: "skipped",
    });
  },
  INIT_FAST_TIMEOUT_MS,
);
test(
  "smithers init rejects unknown templates in option validation before writing the scaffold",
  () => {
    const repo = createTempRepo();
    const result = runSmithers(["init", "--template", "does-not-exist", "--no-install"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: INIT_FAST_TIMEOUT_MS,
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
  },
  INIT_FAST_TIMEOUT_MS,
);
test(
  "smithers init rejects starter aliases before writing the scaffold",
  () => {
    const repo = createTempRepo();
    const result = runSmithers(["init", "--template", "tickets", "--no-install"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: INIT_FAST_TIMEOUT_MS,
    });
    expect(result.exitCode).toBe(4);
    expect(result.json.code).toBe("VALIDATION_ERROR");
    expect(repo.exists(".smithers")).toBe(false);
  },
  INIT_FAST_TIMEOUT_MS,
);
test(
  "smithers init --agents-only creates only the user-owned agent scaffold",
  () => {
    const repo = createTempRepo();
    const result = runSmithers(["init", "--agents-only"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: INIT_FAST_TIMEOUT_MS,
    });
    expect(result.exitCode).toBe(0);
    expect(repo.exists(".smithers/agents/claude-code.ts")).toBe(true);
    expect(repo.exists(".smithers/agents/codex.ts")).toBe(true);
    expect(repo.read(".smithers/agents/codex.ts")).toContain('model: "gpt-5.6-luna"');
    expect(repo.read(".smithers/agents/codex.ts")).toContain('config: { model_reasoning_effort: "medium" }');
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
  },
  INIT_FAST_TIMEOUT_MS,
);
test(
  "smithers init --agents-only is idempotent and preserves user edits",
  () => {
    const repo = createTempRepo();
    const first = runSmithers(["init", "--agents-only"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: INIT_FAST_TIMEOUT_MS,
    });
    expect(first.exitCode).toBe(0);
    const sentinel = `${repo.read(".smithers/agents/codex.ts").trimEnd()}\n// sentinel user edit\n`;
    repo.write(".smithers/agents/codex.ts", sentinel);
    const second = runSmithers(["init", "--agents-only"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: INIT_FAST_TIMEOUT_MS,
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
  },
  INIT_FAST_TIMEOUT_MS,
);
test(
  "smithers init preserves .smithers/executions on an existing repo",
  () => {
    const repo = createTempRepo();
    const env = buildInitEnv(repo.dir);
    repo.write(".smithers/executions/existing-run/logs/events.ndjson", '{"type":"RunFinished"}\n');
    const result = runSmithers(["init"], {
      cwd: repo.dir,
      format: "json",
      env,
      timeoutMs: INIT_INSTALL_TIMEOUT_MS,
    });
    expect(result.exitCode).toBe(0);
    expect(repo.read(".smithers/executions/existing-run/logs/events.ndjson")).toContain("RunFinished");
  },
  INIT_INSTALL_TIMEOUT_MS,
);
test(
  "smithers init preserves curated user edits unless --force is passed",
  () => {
    const repo = createTempRepo();
    const env = buildInitEnv(repo.dir);
    expect(
      runSmithers(["init"], { cwd: repo.dir, format: "json", env, timeoutMs: INIT_INSTALL_TIMEOUT_MS }).exitCode,
    ).toBe(0);
    repo.write(".smithers/workflows/create-workflow.tsx", "// user-edited workflow\n");
    expect(
      runSmithers(["init"], { cwd: repo.dir, format: "json", env, timeoutMs: INIT_INSTALL_TIMEOUT_MS }).exitCode,
    ).toBe(0);
    expect(repo.read(".smithers/workflows/create-workflow.tsx")).toContain("user-edited workflow");
    expect(
      runSmithers(["init", "--force"], { cwd: repo.dir, format: "json", env, timeoutMs: INIT_INSTALL_TIMEOUT_MS })
        .exitCode,
    ).toBe(0);
    expect(repo.read(".smithers/workflows/create-workflow.tsx")).not.toContain("user-edited workflow");
  },
  INIT_INSTALL_TIMEOUT_MS,
);

test(
  "workflow inspect and skills expose curated seeded metadata",
  () => {
    const repo = createTempRepo();
    const env = buildInitEnv(repo.dir);
    expect(
      runSmithers(["init"], { cwd: repo.dir, format: "json", env, timeoutMs: INIT_INSTALL_TIMEOUT_MS }).exitCode,
    ).toBe(0);
    const inspect = runSmithers(["workflow", "inspect", "create-workflow"], {
      cwd: repo.dir,
      format: "json",
      timeoutMs: INIT_FAST_TIMEOUT_MS,
    });
    expect(inspect.exitCode).toBe(0);
    expect(inspect.json.workflow.id).toBe("create-workflow");
    expect(inspect.json.workflow.sourceType).toBe("seeded");
    const skills = runSmithers(
      ["workflow", "skills", "create-workflow", "--output", ".smithers/skills/create-workflow.md"],
      { cwd: repo.dir, format: "json", timeoutMs: INIT_FAST_TIMEOUT_MS },
    );
    expect(skills.exitCode).toBe(0);
    expect(repo.read(".smithers/skills/create-workflow.md")).toContain("name: create-workflow");
  },
  INIT_INSTALL_TIMEOUT_MS,
);
