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
const workflowPath = resolve(here, "../workflows/ddd-generate-docs.tsx");
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
  const root = mkdtempSync(join(tmpdir(), "ddd-generate-docs-e2e-"));
  const binDir = mkdtempSync(join(tmpdir(), "ddd-generate-docs-bin-"));
  tempDirs.push(root, binDir);
  mkdirSync(join(root, ".smithers/spec/content"), { recursive: true });
  mkdirSync(join(root, ".smithers/agents"), { recursive: true });
  cpSync(realDddLib, join(root, ".smithers/lib/ddd"), { recursive: true });
  cpSync(resolve(here, "../agents.ts"), join(root, ".smithers/agents.ts"));
  writeFileSync(join(root, ".smithers/agents/index.ts"), 'export { agents, providers } from "../agents.ts";\n');
  cpSync(realAgents, join(root, ".smithers/agents"), { recursive: true });
  mkdirSync(join(root, ".smithers/workflows"), { recursive: true });
  cpSync(workflowPath, join(root, ".smithers/workflows/ddd-generate-docs.tsx"));
  symlinkSync(realNodeModules, join(root, "node_modules"), "dir");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ddd-generate-docs-e2e", type: "module" }) + "\n");
  writeFileSync(join(root, "README.md"), "# Fixture\n\nA real fixture repo for DDD generation.\n");
  mkdirSync(join(root, "packages/core"), { recursive: true });
  mkdirSync(join(root, "apps/web"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "e2e"), { recursive: true });
  writeFileSync(join(root, "packages/core/package.json"), JSON.stringify({ name: "@fixture/core" }) + "\n");
  writeFileSync(join(root, "apps/web/package.json"), JSON.stringify({ name: "@fixture/web" }) + "\n");
  writeFileSync(join(root, "docs/usage.md"), "# Usage\n");
  writeFileSync(join(root, ".smithers/spec/content/overview.md"), "# Overview\n");
  writeFileSync(join(root, ".smithers/spec/features.json"), `${JSON.stringify([
    {
      id: "known-feature",
      title: "Known Feature",
      summary: "A proven feature in the fixture repo.",
      status: "partial",
      priority: "p0",
      owner: "product",
      missing: ["Attach generated-docs e2e evidence."],
    },
  ], null, 2)}\n`);
  writeFakeCodex(binDir);
  writeFakeSmithers(binDir, "process.stdout.write('detached run-ddd-bugscan-123\\n');");
  return { root, binDir };
}

function writeFakeCodex(binDir: string) {
  const payload = JSON.stringify({
    status: "ready",
    featuresWritten: 1,
    updatedFiles: [".smithers/spec/features.json", ".smithers/spec/content/overview.md"],
    approved: true,
    corrections: [],
    summary: "seeded fake agent refreshed the DDD spec",
  });
  writeFileSync(join(binDir, "codex"), [
    `#!${process.execPath}`,
    `const fs = require("node:fs");`,
    `const payload = process.env.SMITHERS_FAKE_CODEX_RESPONSE ?? ${JSON.stringify(payload)};`,
    `const args = process.argv.slice(2);`,
    `const outputIndex = args.indexOf("--output-last-message");`,
    `if (outputIndex >= 0 && args[outputIndex + 1]) fs.writeFileSync(args[outputIndex + 1], "\\u0060\\u0060\\u0060json\\n" + payload + "\\n\\u0060\\u0060\\u0060\\n", "utf8");`,
    `process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");`,
    ``,
  ].join("\n"));
  chmodSync(join(binDir, "codex"), 0o755);
}

function writeFakeSmithers(binDir: string, body: string) {
  writeFileSync(join(binDir, "smithers"), `#!${process.execPath}\n${body}\n`);
  chmodSync(join(binDir, "smithers"), 0o755);
}

async function runGenerate(
  repo: { root: string; binDir: string },
  runId: string,
  input: Record<string, unknown>,
  options: { fakeCodexResponse?: string } = {},
) {
  return withDddProcessEnvLock(async () => {
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const previousTestAgentPath = process.env.SMITHERS_TEST_AGENT_PATH;
    const previousFakeCodex = process.env.SMITHERS_FAKE_CODEX_RESPONSE;
    process.chdir(repo.root);
    process.env.PATH = `${repo.binDir}:${previousPath ?? ""}`;
    process.env.SMITHERS_TEST_AGENT_PATH = process.env.PATH;
    if (options.fakeCodexResponse !== undefined) process.env.SMITHERS_FAKE_CODEX_RESPONSE = options.fakeCodexResponse;
    try {
      const tempWorkflowPath = join(repo.root, ".smithers/workflows/ddd-generate-docs.tsx");
      const mod = await import(`${tempWorkflowPath}?run=${runId}-${Date.now()}-${Math.random()}`);
      const gateway = new Gateway({ heartbeatMs: 50 });
      gateway.register("ddd-generate-docs", (mod as { default: Parameters<typeof gateway.register>[1] }).default);
      const auth = { triggeredBy: "e2e", scopes: ["*"], role: "operator", tokenId: null };
      await gateway.startRun("ddd-generate-docs", input, auth as Parameters<typeof gateway.startRun>[2], runId, { resume: false });
      const inflight = gateway.inflightRuns.get(runId);
      if (inflight) await inflight;
      gateways.push(gateway);
      return gateway;
    } finally {
      process.chdir(previousCwd);
      process.env.PATH = previousPath;
      if (previousTestAgentPath === undefined) delete process.env.SMITHERS_TEST_AGENT_PATH;
      else process.env.SMITHERS_TEST_AGENT_PATH = previousTestAgentPath;
      if (previousFakeCodex === undefined) delete process.env.SMITHERS_FAKE_CODEX_RESPONSE;
      else process.env.SMITHERS_FAKE_CODEX_RESPONSE = previousFakeCodex;
    }
  });
}

describe("ddd-generate-docs real workflow run", () => {
  test("surveys, drafts, builds, reviews, and honors runBugScan=false", async () => {
    const repo = tempRepo();
    const runId = "ddd-generate-docs-disabled";
    const gateway = await runGenerate(repo, runId, { useClaudeForPlanning: false, runBugScan: false });
    const connection = createConnectionContext();

    const survey = await nodeOutput(gateway, connection, runId, "survey");
    expect(survey.row.hasSpec).toBe(true);
    expect(survey.row.packageNames.sort()).toEqual(["@fixture/core", "@fixture/web", "ddd-generate-docs-e2e"]);
    expect(survey.row.docsFiles).toEqual(["usage.md"]);
    expect(survey.row.testDirs).toEqual(["e2e"]);

    const draft = await nodeOutput(gateway, connection, runId, "draft-spec");
    expect(draft.row.status).toBe("ready");
    expect(draft.row.updatedFiles).toContain(".smithers/spec/features.json");

    const build = await nodeOutput(gateway, connection, runId, "build");
    expect(build.row.passed).toBe(true);
    expect(existsSync(join(repo.root, ".smithers/ui/ddd-docsContent.generated.ts"))).toBe(true);

    const review = await nodeOutput(gateway, connection, runId, "review");
    expect(review.row.approved).toBe(true);

    const kickoff = await nodeOutput(gateway, connection, runId, "kickoff-bug-scan");
    expect(kickoff.row.launched).toBe(false);
    expect(kickoff.row.summary).toContain("runBugScan=false");
  }, 120_000);

  test("records the detached bug-scan run id when kickoff is enabled", async () => {
    const repo = tempRepo();
    const runId = "ddd-generate-docs-enabled";
    const gateway = await runGenerate(repo, runId, { useClaudeForPlanning: false, runBugScan: true });
    const connection = createConnectionContext();

    const kickoff = await nodeOutput(gateway, connection, runId, "kickoff-bug-scan");
    expect(kickoff.row.launched).toBe(true);
    expect(kickoff.row.bugScanRunId).toBe("run-ddd-bugscan-123");
    expect(kickoff.row.summary).toContain("run-ddd-bugscan-123");
  }, 120_000);

  test("records a clear launch failure when the detached bug scan cannot start", async () => {
    const repo = tempRepo();
    writeFakeSmithers(repo.binDir, "process.stderr.write('no cli here\\n'); process.exit(4);");
    const runId = "ddd-generate-docs-launch-failure";
    const gateway = await runGenerate(repo, runId, { useClaudeForPlanning: false, runBugScan: true });
    const connection = createConnectionContext();

    const kickoff = await nodeOutput(gateway, connection, runId, "kickoff-bug-scan");
    expect(kickoff.row.launched).toBe(false);
    expect(kickoff.row.bugScanRunId).toBe("");
    expect(kickoff.row.summary).toContain("Bug scan launch failed:");
  }, 120_000);

  test("blocks the detached bug scan when the review rejects generated docs", async () => {
    const repo = tempRepo();
    const fakeCodexResponse = JSON.stringify({
      status: "ready",
      featuresWritten: 1,
      updatedFiles: [".smithers/spec/features.json"],
      approved: false,
      corrections: ["Downgraded an optimistic status."],
      summary: "fake review rejected the generated spec",
    });
    const runId = "ddd-generate-docs-review-blocked";
    const gateway = await runGenerate(repo, runId, { useClaudeForPlanning: false, runBugScan: true }, { fakeCodexResponse });
    const connection = createConnectionContext();

    const review = await nodeOutput(gateway, connection, runId, "review");
    expect(review.row.approved).toBe(false);

    const kickoff = await nodeOutput(gateway, connection, runId, "kickoff-bug-scan");
    expect(kickoff.row.launched).toBe(false);
    expect(kickoff.row.bugScanRunId).toBe("");
    expect(kickoff.row.summary).toContain("review was not approved");
  }, 120_000);
});
