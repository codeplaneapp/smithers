import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Gateway, mdxPlugin } from "smithers-orchestrator";

mdxPlugin();

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const workflowPath = resolve(here, "../workflows/docs-driven-development.tsx");
const uiEntry = resolve(here, "../ui/docs-driven-development.tsx");
const agentsDir = resolve(repoRoot, ".smithers/agents");

export type DddFixtureRepo = {
  root: string;
  binDir: string;
  cleanup: () => void;
};

export type DddFixtureRepoOptions = {
  features?: unknown[];
};

export type DddFakeAgentResponses = Record<string, string | Record<string, unknown>>;

export async function withDddProcessEnvLock<T>(body: () => Promise<T>): Promise<T> {
  const key = "__smithersDddProcessEnvLock";
  const state = globalThis as typeof globalThis & Record<typeof key, Promise<void> | undefined>;
  const previous = state[key] ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  state[key] = previous.then(() => current);
  await previous;
  try {
    return await body();
  } finally {
    release();
  }
}

export function dddFixtureFeature(overrides: Record<string, unknown> = {}) {
  return {
    id: "docs-driven-development",
    title: "Docs driven development",
    summary: "Maintain the Smithers product spec.",
    status: "fixed",
    priority: "p0",
    owner: "product",
    tier: "feature",
    group: "Ship & review",
    userValue: "Keep docs and implementation work connected.",
    capabilities: [{ title: "Audit loop", detail: "Runs a bounded audit and triage loop.", status: "fixed" }],
    endpoints: [{ method: "POST", path: "/runs", doc: "overview.md#runs", note: "launch workflow runs" }],
    links: [{ label: "Overview", href: "overview.md" }],
    tests: ["bun test tests/docs-driven-development-run.e2e.test.ts"],
    observability: ["gateway run events"],
    debug: ["smithers output <runId> <nodeId>"],
    architecture: ["docs-driven-development workflow"],
    changes: ["fixture seed"],
    diffHints: [".smithers/workflows/docs-driven-development.tsx"],
    missing: [],
    ...overrides,
  };
}

export function createDddFixtureRepo(options: DddFixtureRepoOptions = {}): DddFixtureRepo {
  const root = mkdtempSync(join(tmpdir(), "ddd-run-e2e-"));
  const binDir = mkdtempSync(join(tmpdir(), "ddd-run-bin-"));

  mkdirSync(join(root, ".smithers"), { recursive: true });
  mkdirSync(join(root, ".smithers/agents"), { recursive: true });
  cpSync(resolve(repoRoot, ".smithers/lib/ddd"), join(root, ".smithers/lib/ddd"), { recursive: true });
  mkdirSync(join(root, ".smithers/spec/content"), { recursive: true });
  mkdirSync(join(root, ".smithers/specs"), { recursive: true });
  mkdirSync(join(root, ".smithers/workflows"), { recursive: true });
  cpSync(agentsDir, join(root, ".smithers/agents"), { recursive: true });
  writeFixtureAgents(root, binDir);
  writeFileSync(join(root, ".smithers/spec/features.json"), `${JSON.stringify(options.features ?? [dddFixtureFeature()], null, 2)}\n`);
  writeFileSync(join(root, ".smithers/spec/content/overview.md"), "# Overview\n\nInitial DDD overview.\n");
  writeFileSync(join(root, ".smithers/specs/docs-driven-development.md"), "# Docs Driven Development\n");
  const agentPath = `${binDir}:${process.env.PATH ?? ""}`;
  const workflowSource = readFileSync(workflowPath, "utf8").replace(
    `import { providers } from "../agents";`,
    [
      `import { type AgentLike, ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";`,
      `const fixtureAgentEnv = { PATH: ${JSON.stringify(agentPath)}, SMITHERS_TEST_AGENT_PATH: ${JSON.stringify(agentPath)} };`,
      `const providers = {`,
      `  claude: new ClaudeCodeAgent({ model: "claude-fable-5", env: fixtureAgentEnv }),`,
      `  claudeSonnet: new ClaudeCodeAgent({ model: "claude-sonnet-4-6", env: fixtureAgentEnv }),`,
      `  codex: new CodexAgent({ model: "gpt-5.5", skipGitRepoCheck: true, env: fixtureAgentEnv }),`,
      `} as const;`,
      `const agents = {`,
      `  cheapFast: [providers.claudeSonnet, providers.codex],`,
      `  smart: [providers.claude, providers.claudeSonnet, providers.codex],`,
      `  smartTool: [providers.claude, providers.claudeSonnet, providers.codex],`,
      `  planning: [providers.claude],`,
      `  review: [providers.claude],`,
      `  implement: [providers.codex],`,
      `} as const satisfies Record<string, AgentLike[]>;`,
    ].join("\n"),
  );
  writeFileSync(join(root, ".smithers/workflows/docs-driven-development.tsx"), workflowSource);
  symlinkSync(resolve(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ddd-run-e2e", type: "module" }) + "\n");
  writeFileSync(join(root, ".gitignore"), "node_modules/\n.smithers/tickets/\nsmithers.db*\n");

  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "ddd@example.com"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "DDD Test"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "seed ddd fixture"], { cwd: root, stdio: "pipe" });
  writeFileSync(join(root, ".smithers/spec/content/overview.md"), "# Overview\n\nInitial DDD overview.\n\nUncommitted docs edit.\n");

  writeFakeAgents(binDir);

  return {
    root,
    binDir,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    },
  };
}

function writeFixtureAgents(root: string, binDir: string) {
  const agentPath = `${binDir}:${process.env.PATH ?? ""}`;
  writeFileSync(join(root, ".smithers/agents.ts"), `import { type AgentLike, ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";

const env = {
  PATH: ${JSON.stringify(agentPath)},
  SMITHERS_TEST_AGENT_PATH: ${JSON.stringify(agentPath)},
  ...(process.env.SMITHERS_FAKE_AGENT_RESPONSE ? { SMITHERS_FAKE_AGENT_RESPONSE: process.env.SMITHERS_FAKE_AGENT_RESPONSE } : {}),
  ...(process.env.SMITHERS_FAKE_CODEX_RESPONSE ? { SMITHERS_FAKE_CODEX_RESPONSE: process.env.SMITHERS_FAKE_CODEX_RESPONSE } : {}),
  ...(process.env.SMITHERS_FAKE_CLAUDE_RESPONSE ? { SMITHERS_FAKE_CLAUDE_RESPONSE: process.env.SMITHERS_FAKE_CLAUDE_RESPONSE } : {}),
  ...(process.env.SMITHERS_FAKE_AGENT_RESPONSES_BY_NODE ? { SMITHERS_FAKE_AGENT_RESPONSES_BY_NODE: process.env.SMITHERS_FAKE_AGENT_RESPONSES_BY_NODE } : {}),
};
export const providers = {
  claude: new ClaudeCodeAgent({ model: "claude-fable-5", env }),
  claudeSonnet: new ClaudeCodeAgent({ model: "claude-sonnet-4-6", env }),
  codex: new CodexAgent({ model: "gpt-5.5", skipGitRepoCheck: true, env }),
} as const;

export const agents = {
  cheapFast: [providers.claudeSonnet, providers.codex],
  smart: [providers.claude, providers.claudeSonnet, providers.codex],
  smartTool: [providers.claude, providers.claudeSonnet, providers.codex],
  planning: [providers.claude],
  review: [providers.claude],
  implement: [providers.codex],
} as const satisfies Record<string, AgentLike[]>;
`);
  writeFileSync(join(root, ".smithers/agents/index.ts"), 'export { agents, providers } from "../agents.ts";\n');
}

function writeFakeAgents(binDir: string) {
  const claudeSrc = [
    `#!/usr/bin/env node`,
    `const fs = require("node:fs");`,
    `const args = process.argv.slice(2);`,
    `if (args.join(" ") === "auth status") { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) + "\\n"); process.exit(0); }`,
    `function promptText() { try { return args.join("\\n") + "\\n" + fs.readFileSync(0, "utf8"); } catch { return args.join("\\n"); } }`,
    `function pickPayload() {`,
    `  const fallback = process.env.SMITHERS_FAKE_CLAUDE_RESPONSE ?? process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? "{}";`,
    `  let byNode = {};`,
    `  try { byNode = JSON.parse(process.env.SMITHERS_FAKE_AGENT_RESPONSES_BY_NODE ?? "{}"); } catch {}`,
    `  const prompt = promptText();`,
    `  const pairs = [["audit", "Audit the current docs-driven-development spec state"], ["spec-update", "Update the smithers product spec"], ["triage", "Plan the next docs-driven-development round"], ["work:1", "Implement or execute triage slot 1"], ["work:1", "No triage item selected for slot 1"], ["cycle-review", "Review this entire docs-driven-development cycle"]];`,
    `  for (const [node, marker] of pairs) if (prompt.includes(marker) && byNode[node]) return typeof byNode[node] === "string" ? byNode[node] : JSON.stringify(byNode[node]);`,
    `  return fallback;`,
    `}`,
    `const payload = pickPayload();`,
    `process.stdout.write(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "\\u0060\\u0060\\u0060json\\n" + payload + "\\n\\u0060\\u0060\\u0060\\n" }] } }) + "\\n");`,
    ``,
  ].join("\n");
  writeFileSync(join(binDir, "claude"), claudeSrc);
  chmodSync(join(binDir, "claude"), 0o755);

  const codexSrc = [
    `#!/usr/bin/env node`,
    `const fs = require("node:fs");`,
    `const args = process.argv.slice(2);`,
    `function promptText() { try { return args.join("\\n") + "\\n" + fs.readFileSync(0, "utf8"); } catch { return args.join("\\n"); } }`,
    `function pickPayload() {`,
    `  const fallback = process.env.SMITHERS_FAKE_CODEX_RESPONSE ?? process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? "{}";`,
    `  let byNode = {};`,
    `  try { byNode = JSON.parse(process.env.SMITHERS_FAKE_AGENT_RESPONSES_BY_NODE ?? "{}"); } catch {}`,
    `  const prompt = promptText();`,
    `  const pairs = [["audit", "Audit the current docs-driven-development spec state"], ["spec-update", "Update the smithers product spec"], ["triage", "Plan the next docs-driven-development round"], ["work:1", "Implement or execute triage slot 1"], ["work:1", "No triage item selected for slot 1"], ["cycle-review", "Review this entire docs-driven-development cycle"]];`,
    `  for (const [node, marker] of pairs) if (prompt.includes(marker) && byNode[node]) return typeof byNode[node] === "string" ? byNode[node] : JSON.stringify(byNode[node]);`,
    `  return fallback;`,
    `}`,
    `const payload = pickPayload();`,
    `const outputIndex = args.indexOf("--output-last-message");`,
    `if (outputIndex >= 0 && args[outputIndex + 1]) fs.writeFileSync(args[outputIndex + 1], "\\u0060\\u0060\\u0060json\\n" + payload + "\\n\\u0060\\u0060\\u0060\\n", "utf8");`,
    `process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");`,
    ``,
  ].join("\n");
  writeFileSync(join(binDir, "codex"), codexSrc);
  chmodSync(join(binDir, "codex"), 0o755);
}

export function fakeAgentResponse(summary: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    generatedSiteBuilds: true,
    featureIds: ["docs-driven-development"],
    broken: [],
    partial: [],
    missingE2E: [],
    missingDocs: [],
    notes: [`${summary} audit note`],
    status: "partial",
    updatedFiles: [".smithers/spec/features.json"],
    commandsRun: ["bun .smithers/lib/ddd/build.ts"],
    selected: [
      {
        slot: 1,
        featureId: "docs-driven-development",
        title: "Prove DDD workflow execution",
        agent: "sonnet",
        taskType: "e2e",
        reason: `${summary} selected a DDD proof task.`,
        files: [".smithers/workflows/docs-driven-development.tsx"],
        tests: ["bun test tests/docs-driven-development-run.e2e.test.ts"],
        acceptance: ["The real workflow run produces materialized tickets and node outputs."],
      },
    ],
    slot: 1,
    featureId: "docs-driven-development",
    filesChanged: [".smithers/spec/features.json"],
    testsRun: ["bun test tests/docs-driven-development-run.e2e.test.ts"],
    issuesCreated: [],
    approved: true,
    blockingFindings: [],
    inefficiencies: [],
    summary,
    ...overrides,
  });
}

function serializeFakeResponsesByNode(responses: DddFakeAgentResponses | undefined): string | undefined {
  if (!responses) return undefined;
  return JSON.stringify(Object.fromEntries(
    Object.entries(responses).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
  ));
}

export async function withDddFixtureExecutionEnv<T>(
  repo: DddFixtureRepo,
  body: () => Promise<T>,
  options: { agentResponsesByNode?: DddFakeAgentResponses } = {},
): Promise<T> {
  return withDddProcessEnvLock(async () => {
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const previousCodex = process.env.SMITHERS_FAKE_CODEX_RESPONSE;
    const previousClaude = process.env.SMITHERS_FAKE_CLAUDE_RESPONSE;
    const previousByNode = process.env.SMITHERS_FAKE_AGENT_RESPONSES_BY_NODE;
    const previousTestAgentPath = process.env.SMITHERS_TEST_AGENT_PATH;
    process.chdir(repo.root);
    process.env.PATH = `${repo.binDir}:${process.env.PATH ?? ""}`;
    process.env.SMITHERS_TEST_AGENT_PATH = process.env.PATH;
    process.env.SMITHERS_FAKE_CODEX_RESPONSE = fakeAgentResponse("codex fake output");
    process.env.SMITHERS_FAKE_CLAUDE_RESPONSE = fakeAgentResponse("claude fake output");
    const byNode = serializeFakeResponsesByNode(options.agentResponsesByNode);
    if (byNode) process.env.SMITHERS_FAKE_AGENT_RESPONSES_BY_NODE = byNode;
    else delete process.env.SMITHERS_FAKE_AGENT_RESPONSES_BY_NODE;
    try {
      return await body();
    } finally {
      process.chdir(previousCwd);
      process.env.PATH = previousPath;
      if (previousCodex === undefined) delete process.env.SMITHERS_FAKE_CODEX_RESPONSE;
      else process.env.SMITHERS_FAKE_CODEX_RESPONSE = previousCodex;
      if (previousClaude === undefined) delete process.env.SMITHERS_FAKE_CLAUDE_RESPONSE;
      else process.env.SMITHERS_FAKE_CLAUDE_RESPONSE = previousClaude;
      if (previousByNode === undefined) delete process.env.SMITHERS_FAKE_AGENT_RESPONSES_BY_NODE;
      else process.env.SMITHERS_FAKE_AGENT_RESPONSES_BY_NODE = previousByNode;
      if (previousTestAgentPath === undefined) delete process.env.SMITHERS_TEST_AGENT_PATH;
      else process.env.SMITHERS_TEST_AGENT_PATH = previousTestAgentPath;
    }
  });
}

export async function runDddWorkflow(
  repo: DddFixtureRepo,
  runId: string,
  input: Record<string, unknown>,
  options: { agentResponsesByNode?: DddFakeAgentResponses } = {},
) {
  return withDddFixtureExecutionEnv(repo, async () => {
      const tempWorkflowPath = join(repo.root, ".smithers/workflows/docs-driven-development.tsx");
      const mod = await import(`${tempWorkflowPath}?run=${encodeURIComponent(runId)}-${Date.now()}-${Math.random()}`);
      const gateway = new Gateway({ heartbeatMs: 50 });
      gateway.register("docs-driven-development", (mod as { default: Parameters<typeof gateway.register>[1] }).default, {
        ui: { entry: uiEntry, title: "Docs Driven Development" },
      });
      const auth = { triggeredBy: "e2e", scopes: ["*"], role: "operator", tokenId: null };
      await gateway.startRun("docs-driven-development", input, auth as Parameters<typeof gateway.startRun>[2], runId, { resume: false });
      let inflight = gateway.inflightRuns.get(runId);
      for (let attempt = 0; !inflight && attempt < 50; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        inflight = gateway.inflightRuns.get(runId);
      }
      if (inflight) {
        await inflight;
      } else {
        for (let attempt = 0; attempt < 2400; attempt += 1) {
          const response = await gatewayRequest(gateway, createConnectionContext(), "runs.list", { limit: 100 });
          const rows = (response.ok && Array.isArray(response.payload) ? response.payload : []) as Array<Record<string, unknown>>;
          const status = rows.find((row) => row.runId === runId)?.status;
          if (status === "finished" || status === "failed" || status === "canceled") break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      return gateway;
    },
    options,
  );
}

export function createConnectionContext() {
  return {
    connectionId: `ddd-e2e-${Math.random().toString(36).slice(2)}`,
    transport: "test",
    authenticated: true,
    sessionToken: "test-session",
    role: "operator",
    scopes: ["*"],
    userId: "user:ddd-e2e",
    subscribedRuns: new Set<string>(),
    heartbeatTimer: null,
  };
}

export async function gatewayRequest(gateway: Gateway, connection: ReturnType<typeof createConnectionContext>, method: string, params?: Record<string, unknown>) {
  return (gateway as any).routeRequest(connection, {
    type: "req",
    id: `${method}-${Math.random().toString(36).slice(2)}`,
    method,
    params,
  });
}

export async function nodeOutput(gateway: Gateway, connection: ReturnType<typeof createConnectionContext>, runId: string, nodeId: string, iteration = 0) {
  const response = await gatewayRequest(gateway, connection, "getNodeOutput", { runId, nodeId, iteration });
  if (!response.ok) throw new Error(`getNodeOutput ${nodeId} failed: ${response.error?.code ?? "unknown"}`);
  return response.payload;
}
