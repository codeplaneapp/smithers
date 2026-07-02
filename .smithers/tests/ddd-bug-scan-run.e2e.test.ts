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
  cpSync(resolve(here, "../agents.ts"), join(root, ".smithers/agents.ts"));
  writeFileSync(join(root, ".smithers/agents/index.ts"), 'export { agents, providers } from "../agents.ts";\n');
  cpSync(realAgents, join(root, ".smithers/agents"), { recursive: true });
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

function writeFakeCodex(binDir: string, payload: unknown) {
  writeFileSync(join(binDir, "codex"), [
    `#!${process.execPath}`,
    `const fs = require("node:fs");`,
    `const payload = process.env.SMITHERS_FAKE_CODEX_RESPONSE ?? ${JSON.stringify(JSON.stringify(payload))};`,
    `const args = process.argv.slice(2);`,
    `const outputIndex = args.indexOf("--output-last-message");`,
    `if (outputIndex >= 0 && args[outputIndex + 1]) fs.writeFileSync(args[outputIndex + 1], "\\u0060\\u0060\\u0060json\\n" + payload + "\\n\\u0060\\u0060\\u0060\\n", "utf8");`,
    `process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");`,
    ``,
  ].join("\n"));
  chmodSync(join(binDir, "codex"), 0o755);
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
    expect(filed.row.ticketPaths[0]).toBe("ddd-bug-scan--packages-core-src-trim.ts--null-trim-crashes.md");

    const ticketPath = join(repo.root, ".smithers/tickets", filed.row.ticketPaths[0]);
    expect(existsSync(ticketPath)).toBe(true);
    expect(readFileSync(ticketPath, "utf8")).toContain("trimName(null) throws before validation.");
    expect(readFileSync(ticketPath, "utf8")).toContain("Feature title: Known Feature");
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
