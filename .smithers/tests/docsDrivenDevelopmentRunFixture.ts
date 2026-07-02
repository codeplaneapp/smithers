import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

export function createDddFixtureRepo(): DddFixtureRepo {
  const root = mkdtempSync(join(tmpdir(), "ddd-run-e2e-"));
  const binDir = mkdtempSync(join(tmpdir(), "ddd-run-bin-"));

  mkdirSync(join(root, ".smithers"), { recursive: true });
  mkdirSync(join(root, ".smithers/agents"), { recursive: true });
  cpSync(resolve(repoRoot, ".smithers/agents.ts"), join(root, ".smithers/agents.ts"));
  writeFileSync(join(root, ".smithers/agents/index.ts"), 'export { agents, providers } from "../agents.ts";\n');
  cpSync(resolve(repoRoot, ".smithers/lib/ddd"), join(root, ".smithers/lib/ddd"), { recursive: true });
  mkdirSync(join(root, ".smithers/spec/content"), { recursive: true });
  mkdirSync(join(root, ".smithers/specs"), { recursive: true });
  mkdirSync(join(root, ".smithers/workflows"), { recursive: true });
  cpSync(agentsDir, join(root, ".smithers/agents"), { recursive: true });
  writeFileSync(join(root, ".smithers/spec/features.json"), `${JSON.stringify([
    {
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
    },
  ], null, 2)}\n`);
  writeFileSync(join(root, ".smithers/spec/content/overview.md"), "# Overview\n\nInitial DDD overview.\n");
  writeFileSync(join(root, ".smithers/specs/docs-driven-development.md"), "# Docs Driven Development\n");
  cpSync(workflowPath, join(root, ".smithers/workflows/docs-driven-development.tsx"));
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

function writeFakeAgents(binDir: string) {
  const claudeSrc = [
    `#!${process.execPath}`,
    `const args = process.argv.slice(2);`,
    `if (args.join(" ") === "auth status") { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) + "\\n"); process.exit(0); }`,
    `const payload = process.env.SMITHERS_FAKE_CLAUDE_RESPONSE ?? process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? "{}";`,
    `process.stdout.write(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "\\u0060\\u0060\\u0060json\\n" + payload + "\\n\\u0060\\u0060\\u0060\\n" }] } }) + "\\n");`,
    ``,
  ].join("\n");
  writeFileSync(join(binDir, "claude"), claudeSrc);
  chmodSync(join(binDir, "claude"), 0o755);

  const codexSrc = [
    `#!${process.execPath}`,
    `const fs = require("node:fs");`,
    `const payload = process.env.SMITHERS_FAKE_CODEX_RESPONSE ?? process.env.SMITHERS_FAKE_AGENT_RESPONSE ?? "{}";`,
    `const args = process.argv.slice(2);`,
    `const outputIndex = args.indexOf("--output-last-message");`,
    `if (outputIndex >= 0 && args[outputIndex + 1]) fs.writeFileSync(args[outputIndex + 1], "\\u0060\\u0060\\u0060json\\n" + payload + "\\n\\u0060\\u0060\\u0060\\n", "utf8");`,
    `process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");`,
    ``,
  ].join("\n");
  writeFileSync(join(binDir, "codex"), codexSrc);
  chmodSync(join(binDir, "codex"), 0o755);
}

export function fakeAgentResponse(summary: string) {
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
  });
}

export async function runDddWorkflow(repo: DddFixtureRepo, runId: string, input: Record<string, unknown>) {
  return withDddProcessEnvLock(async () => {
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const previousCodex = process.env.SMITHERS_FAKE_CODEX_RESPONSE;
    const previousClaude = process.env.SMITHERS_FAKE_CLAUDE_RESPONSE;
    const previousTestAgentPath = process.env.SMITHERS_TEST_AGENT_PATH;
    process.chdir(repo.root);
    process.env.PATH = `${repo.binDir}:${process.env.PATH ?? ""}`;
    process.env.SMITHERS_TEST_AGENT_PATH = process.env.PATH;
    process.env.SMITHERS_FAKE_CODEX_RESPONSE = fakeAgentResponse("codex fake output");
    process.env.SMITHERS_FAKE_CLAUDE_RESPONSE = fakeAgentResponse("claude fake output");

    try {
      const tempWorkflowPath = join(repo.root, ".smithers/workflows/docs-driven-development.tsx");
      const mod = await import(`${tempWorkflowPath}?run=${encodeURIComponent(runId)}-${Date.now()}-${Math.random()}`);
      const gateway = new Gateway({ heartbeatMs: 50 });
      gateway.register("docs-driven-development", (mod as { default: Parameters<typeof gateway.register>[1] }).default, {
        ui: { entry: uiEntry, title: "Docs Driven Development" },
      });
      const auth = { triggeredBy: "e2e", scopes: ["*"], role: "operator", tokenId: null };
      await gateway.startRun("docs-driven-development", input, auth as Parameters<typeof gateway.startRun>[2], runId, { resume: false });
      const inflight = gateway.inflightRuns.get(runId);
      if (inflight) await inflight;
      return gateway;
    } finally {
      process.chdir(previousCwd);
      process.env.PATH = previousPath;
      if (previousCodex === undefined) delete process.env.SMITHERS_FAKE_CODEX_RESPONSE;
      else process.env.SMITHERS_FAKE_CODEX_RESPONSE = previousCodex;
      if (previousClaude === undefined) delete process.env.SMITHERS_FAKE_CLAUDE_RESPONSE;
      else process.env.SMITHERS_FAKE_CLAUDE_RESPONSE = previousClaude;
      if (previousTestAgentPath === undefined) delete process.env.SMITHERS_TEST_AGENT_PATH;
      else process.env.SMITHERS_TEST_AGENT_PATH = previousTestAgentPath;
    }
  });
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

export async function nodeOutput(gateway: Gateway, connection: ReturnType<typeof createConnectionContext>, runId: string, nodeId: string) {
  const response = await gatewayRequest(gateway, connection, "getNodeOutput", { runId, nodeId, iteration: 0 });
  if (!response.ok) throw new Error(`getNodeOutput ${nodeId} failed: ${response.error?.code ?? "unknown"}`);
  return response.payload;
}
