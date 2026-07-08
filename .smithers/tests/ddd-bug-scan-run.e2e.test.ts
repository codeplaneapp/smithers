import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Gateway, mdxPlugin } from "smithers-orchestrator";
import { createConnectionContext, nodeOutput, withDddProcessEnvLock } from "./docsDrivenDevelopmentRunFixture.ts";

mdxPlugin();

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const workflowPath = resolve(here, "../workflows/ddd-bug-scan.tsx");
const realDddLib = resolve(here, "../lib/ddd");
const realAgents = resolve(repoRoot, ".smithers/agents");
const realNodeModules = resolve(repoRoot, "node_modules");
const tempDirs: string[] = [];
const gateways: Gateway[] = [];

afterEach(async () => {
  while (gateways.length > 0) {
    try {
      await gateways.pop()!.close();
    } catch {}
  }
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "ddd-bug-scan-e2e-"));
  const binDir = mkdtempSync(join(tmpdir(), "ddd-bug-scan-bin-"));
  tempDirs.push(root, binDir);
  mkdirSync(join(root, ".smithers/spec/content"), { recursive: true });
  mkdirSync(join(root, ".smithers/agents"), { recursive: true });
  cpSync(realDddLib, join(root, ".smithers/lib/ddd"), { recursive: true });
  cpSync(realAgents, join(root, ".smithers/agents"), { recursive: true });
  writeFixtureAgents(root, binDir);
  mkdirSync(join(root, ".smithers/workflows"), { recursive: true });
  cpSync(workflowPath, join(root, ".smithers/workflows/ddd-bug-scan.tsx"));
  symlinkSync(realNodeModules, join(root, "node_modules"), "dir");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ddd-bug-scan-e2e", type: "module" }) + "\n");
  writeFileSync(join(root, ".smithers/spec/content/overview.md"), "# Overview\n");
  writeFileSync(join(root, ".smithers/spec/features.json"), `${JSON.stringify([
    {
      id: "known-feature",
      title: "Known Feature",
      summary: "A feature with a verifiable bug.",
      status: "partial",
      priority: "p0",
      owner: "product",
      missing: [],
    },
  ], null, 2)}\n`);
  return { root, binDir };
}

function writeFixtureAgents(root: string, binDir: string) {
  writeFileSync(join(root, ".smithers/agents.ts"), `import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentLike } from "smithers-orchestrator";

const fixtureBinDir = ${JSON.stringify(binDir)};

class FixtureAgent implements AgentLike {
  id: string;
  model: string;
  engine: "claude" | "codex";
  supportsNativeStructuredOutput = false;

  constructor(engine: "claude" | "codex", model: string, id: string) {
    this.engine = engine;
    this.model = model;
    this.id = id;
  }

  async preflight() {}

  async generate(args: any = {}) {
    const root = args.rootDir ?? process.cwd();
    const prompt = typeof args.prompt === "string" ? args.prompt : JSON.stringify(args.messages ?? []);
    const payloadPath = join(fixtureBinDir, this.engine + "-response.json");
    const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
    appendFileSync(join(root, this.engine + "-calls.jsonl"), JSON.stringify({ args: ["--model", this.model], prompt, payload }) + "\\n");
    const text = "\\u0060\\u0060\\u0060json\\n" + JSON.stringify(payload) + "\\n\\u0060\\u0060\\u0060\\n";
    return { text, response: { modelId: this.model, messages: [{ role: "assistant", content: [{ type: "text", text }] }] } };
  }
}

export const providers = {
  claude: new FixtureAgent("claude", "claude-fable-5", "fixture-claude"),
  claudeSonnet: new FixtureAgent("claude", "claude-sonnet-5", "fixture-claude-sonnet"),
  codex: new FixtureAgent("codex", "gpt-5.5", "fixture-codex"),
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
  // The DDD workflows import providers from ../lib/ddd/dddAgents.ts (which builds
  // real ClaudeCodeAgent/CodexAgent that spawn CLIs and preflight-check for a
  // real binary on PATH — impossible on CI). Point that import at the in-process
  // fixture agents so the e2e run stays deterministic and CLI-free.
  writeFileSync(join(root, ".smithers/lib/ddd/dddAgents.ts"), 'export { agents, providers } from "../../agents.ts";\n');
}

function writeFakeCodex(binDir: string, payload: unknown) {
  writeFileSync(join(binDir, "codex-response.json"), `${JSON.stringify(payload)}\n`);
  writeFileSync(join(binDir, "codex"), [
    `#!/usr/bin/env node`,
    `const fs = require("node:fs");`,
    `const payload = process.env.SMITHERS_FAKE_CODEX_RESPONSE ?? ${JSON.stringify(JSON.stringify(payload))};`,
    `const args = process.argv.slice(2);`,
    `function promptText() { try { return args.join("\\n") + "\\n" + fs.readFileSync(0, "utf8"); } catch { return args.join("\\n"); } }`,
    `fs.appendFileSync("codex-calls.jsonl", JSON.stringify({ args, prompt: promptText(), payload: JSON.parse(payload) }) + "\\n");`,
    `const outputIndex = args.indexOf("--output-last-message");`,
    `if (outputIndex >= 0 && args[outputIndex + 1]) fs.writeFileSync(args[outputIndex + 1], "\\u0060\\u0060\\u0060json\\n" + payload + "\\n\\u0060\\u0060\\u0060\\n", "utf8");`,
    `process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");`,
    ``,
  ].join("\n"));
  chmodSync(join(binDir, "codex"), 0o755);
}

function writeFakeClaude(binDir: string, payload: unknown) {
  writeFileSync(join(binDir, "claude-response.json"), `${JSON.stringify(payload)}\n`);
  writeFileSync(join(binDir, "claude"), [
    `#!/usr/bin/env node`,
    `const fs = require("node:fs");`,
    `const args = process.argv.slice(2);`,
    `if (args.join(" ") === "auth status") { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) + "\\n"); process.exit(0); }`,
    `const payload = process.env.SMITHERS_FAKE_CLAUDE_RESPONSE ?? ${JSON.stringify(JSON.stringify(payload))};`,
    `const prompt = args.join("\\n");`,
    `fs.appendFileSync("claude-calls.jsonl", JSON.stringify({ args, prompt, payload: JSON.parse(payload) }) + "\\n");`,
    `const answer = "\\u0060\\u0060\\u0060json\\n" + payload + "\\n\\u0060\\u0060\\u0060\\n";`,
    `process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-claude-ddd-bug-scan" }) + "\\n");`,
    `process.stdout.write(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: answer }] } }) + "\\n");`,
    `process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: answer, session_id: "fake-claude-ddd-bug-scan" }) + "\\n");`,
    ``,
  ].join("\n"));
  chmodSync(join(binDir, "claude"), 0o755);
}

async function runBugScan(repo: { root: string; binDir: string }, runId: string, input: Record<string, unknown>) {
  return withDddProcessEnvLock(async () => {
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const previousTestAgentPath = process.env.SMITHERS_TEST_AGENT_PATH;
    process.chdir(repo.root);
    process.env.PATH = `${repo.binDir}:${previousPath ?? ""}`;
    process.env.SMITHERS_TEST_AGENT_PATH = process.env.PATH;
    try {
      const tempWorkflowPath = join(repo.root, ".smithers/workflows/ddd-bug-scan.tsx");
      const mod = await import(`${tempWorkflowPath}?run=${runId}-${Date.now()}-${Math.random()}`);
      const gateway = new Gateway({ heartbeatMs: 50 });
      gateway.register("ddd-bug-scan", (mod as { default: Parameters<typeof gateway.register>[1] }).default);
      const auth = { triggeredBy: "e2e", scopes: ["*"], role: "operator", tokenId: null };
      await gateway.startRun("ddd-bug-scan", input, auth as Parameters<typeof gateway.startRun>[2], runId, { resume: false });
      const inflight = gateway.inflightRuns.get(runId);
      if (inflight) await inflight;
      gateways.push(gateway);
      return gateway;
    } finally {
      process.chdir(previousCwd);
      process.env.PATH = previousPath;
      if (previousTestAgentPath === undefined) delete process.env.SMITHERS_TEST_AGENT_PATH;
      else process.env.SMITHERS_TEST_AGENT_PATH = previousTestAgentPath;
    }
  });
}

describe("ddd-bug-scan real workflow run", () => {
  test("uses the default Claude verifier while the scan prompt preserves the default maxFindings bound", async () => {
    const repo = tempRepo();
    const finding = {
      id: "default-bound",
      title: "Default bound issue",
      severity: "minor",
      featureId: "known-feature",
      file: "packages/core/src/default.ts",
      evidence: "The default scan path found a bounded issue.",
    };
    writeFakeCodex(repo.binDir, {
      findings: [finding],
      areasCovered: ["packages/core"],
      summary: "codex default scan",
    });
    writeFakeClaude(repo.binDir, {
      confirmed: [finding],
      rejected: [],
      summary: "claude verified the default scan",
    });

    const runId = "ddd-bug-scan-default-claude";
    const gateway = await runBugScan(repo, runId, {});
    const connection = createConnectionContext();

    const scan = await nodeOutput(gateway, connection, runId, "scan");
    expect(scan.row.summary).toBe("codex default scan");
    expect(scan.row.findings).toHaveLength(1);

    const verify = await nodeOutput(gateway, connection, runId, "verify");
    expect(verify.row.summary).toBe("claude verified the default scan");
    expect(verify.row.confirmed[0]).toMatchObject({ id: "default-bound", featureId: "known-feature" });

    const filed = await nodeOutput(gateway, connection, runId, "file-tickets");
    expect(filed.row.created).toBe(1);

    const codexCalls = readFileSync(join(repo.root, "codex-calls.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { prompt: string });
    expect(codexCalls[0]!.prompt).toContain("Report at most 8 findings");

    const claudeCalls = readFileSync(join(repo.root, "claude-calls.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { args: string[]; prompt: string; payload: { summary?: string } });
    expect(claudeCalls).toHaveLength(1);
    expect(claudeCalls[0]!.args).toEqual(expect.arrayContaining(["--model", "claude-fable-5"]));
    expect(claudeCalls[0]!.prompt).toContain("Adversarially verify each finding below");
    expect(claudeCalls[0]!.prompt).toContain("default-bound");
    expect(claudeCalls[0]!.payload.summary).toBe("claude verified the default scan");
  }, 120_000);

  test("scans, verifies, files a ticket, updates features.json, and rebuilds generated docs", async () => {
    const repo = tempRepo();
    const finding = {
      id: "null-trim",
      title: "Null trim crashes",
      severity: "major",
      featureId: "known-feature",
      file: "packages/core/src/trim.ts",
      evidence: "trimName(null) throws before validation.",
      suggestedFix: "Return an empty string for null input before calling trim.",
    };
    writeFakeCodex(repo.binDir, {
      findings: [finding],
      areasCovered: [".smithers/lib/ddd", "packages/core"],
      confirmed: [finding],
      rejected: [],
      summary: "confirmed a null trim crash",
    });

    const runId = "ddd-bug-scan-confirmed";
    const gateway = await runBugScan(repo, runId, { maxFindings: 3, useClaudeForPlanning: false });
    const connection = createConnectionContext();

    const scan = await nodeOutput(gateway, connection, runId, "scan");
    expect(scan.row.findings[0]).toMatchObject({ id: "null-trim", featureId: "known-feature" });
    expect(scan.row.areasCovered).toContain("packages/core");

    const verify = await nodeOutput(gateway, connection, runId, "verify");
    expect(verify.row.confirmed[0]).toMatchObject({ id: "null-trim", severity: "major" });

    const filed = await nodeOutput(gateway, connection, runId, "file-tickets");
    expect(filed.row.created).toBe(1);
    expect(filed.row.featuresUpdated).toEqual(["known-feature"]);
    expect(filed.row.buildPassed).toBe(true);
    expect(filed.row.ticketPaths[0]).toMatch(
      /^ddd-bug-scan--packages-core-src-trim\.ts--null-trim--null-trim-crashes--[0-9a-f]{8}\.md$/,
    );

    const ticketPath = join(repo.root, ".smithers/tickets", filed.row.ticketPaths[0]);
    expect(existsSync(ticketPath)).toBe(true);
    expect(readFileSync(ticketPath, "utf8")).toContain("trimName(null) throws before validation.");
    expect(readFileSync(ticketPath, "utf8")).toContain("Feature title: Known Feature");
    expect(readFileSync(ticketPath, "utf8")).toContain("Priority: P0");
    expect(readFileSync(join(repo.root, ".smithers/spec/features.json"), "utf8")).toContain(
      "Bug (major): Null trim crashes [packages/core/src/trim.ts]",
    );
    expect(readFileSync(join(repo.root, ".smithers/spec/content/features/known-feature.md"), "utf8")).toContain("Null trim crashes");
  }, 120_000);

  test("handles zero confirmed findings without filing tickets", async () => {
    const repo = tempRepo();
    writeFakeCodex(repo.binDir, {
      findings: [
        {
          id: "unproven",
          title: "Unproven issue",
          severity: "minor",
          featureId: "known-feature",
          file: "packages/core/src/index.ts",
          evidence: "Suspicious only.",
        },
      ],
      areasCovered: ["packages/core"],
      confirmed: [],
      rejected: [{ id: "unproven", reason: "Could not reproduce." }],
      summary: "no confirmed findings",
    });

    const runId = "ddd-bug-scan-zero";
    const gateway = await runBugScan(repo, runId, { maxFindings: 1, useClaudeForPlanning: false });
    const connection = createConnectionContext();

    const verify = await nodeOutput(gateway, connection, runId, "verify");
    expect(verify.row.confirmed).toEqual([]);
    expect(verify.row.rejected[0]).toMatchObject({ id: "unproven" });

    const filed = await nodeOutput(gateway, connection, runId, "file-tickets");
    expect(filed.row.created).toBe(0);
    expect(filed.row.ticketPaths).toEqual([]);
    expect(filed.row.featuresUpdated).toEqual([]);
    expect(filed.row.summary).toBe("No confirmed findings; nothing filed.");
  }, 120_000);
});
