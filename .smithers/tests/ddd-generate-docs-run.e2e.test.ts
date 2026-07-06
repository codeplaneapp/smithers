import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Gateway, mdxPlugin } from "smithers-orchestrator";
import { createConnectionContext, gatewayRequest, nodeOutput, withDddProcessEnvLock } from "./docsDrivenDevelopmentRunFixture.ts";

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
  cpSync(realAgents, join(root, ".smithers/agents"), { recursive: true });
  writeFixtureAgents(root, binDir);
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

function writeFixtureAgents(root: string, binDir: string) {
  writeFileSync(join(root, ".smithers/agents.ts"), `import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentLike } from "smithers-orchestrator";

const defaultCodexPayload = ${JSON.stringify(JSON.stringify({
  status: "ready",
  featuresWritten: 1,
  updatedFiles: [".smithers/spec/features.json", ".smithers/spec/content/overview.md"],
  approved: true,
  corrections: [],
  summary: "seeded fake agent refreshed the DDD spec",
}))};

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
    const modelArgs = ["--model", this.model];
    let payload: Record<string, unknown>;

    if (this.engine === "codex") {
      if (process.env.SMITHERS_FAKE_CODEX_INVALID_AFTER_DRAFT === "1" && prompt.includes("Generate (or refresh) the living product spec")) {
        writeFileSync(join(root, ".smithers/spec/features.json"), JSON.stringify([{ id: "known-feature", title: "Known Feature", summary: "Invalid draft left by fake agent", status: "not-real", priority: "p0", owner: "product", missing: [] }], null, 2) + "\\n");
      }
      if (process.env.SMITHERS_FAKE_CODEX_INVALID_AFTER_REVIEW === "1" && prompt.includes("Adversarially review the freshly generated spec")) {
        writeFileSync(join(root, ".smithers/spec/features.json"), JSON.stringify([{ id: "known-feature", title: "Known Feature", summary: "Review corrupted the spec after the first build", status: "not-real", priority: "p0", owner: "product", missing: [] }], null, 2) + "\\n");
      }
      payload = JSON.parse(process.env.SMITHERS_FAKE_CODEX_RESPONSE ?? defaultCodexPayload);
    } else {
      const task = prompt.includes("Generate (or refresh) the living product spec") ? "draft-spec" : prompt.includes("Adversarially review the freshly generated spec") ? "review" : "unknown";
      payload = task === "review"
        ? { approved: true, corrections: [], summary: "fake claude review approved generated docs" }
        : { status: "ready", featuresWritten: 1, updatedFiles: [".smithers/spec/features.json", ".smithers/spec/content/overview.md"], summary: "fake claude draft refreshed the DDD spec" };
      appendFileSync(join(root, "claude-calls.jsonl"), JSON.stringify({ task, args: modelArgs, prompt, payload }) + "\\n");
    }

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
    `#!/usr/bin/env node`,
    `const fs = require("node:fs");`,
    `const payload = process.env.SMITHERS_FAKE_CODEX_RESPONSE ?? ${JSON.stringify(payload)};`,
    `const args = process.argv.slice(2);`,
    `function promptText() { try { return args.join("\\n") + "\\n" + fs.readFileSync(0, "utf8"); } catch { return args.join("\\n"); } }`,
    `if (process.env.SMITHERS_FAKE_CODEX_INVALID_AFTER_DRAFT === "1" && promptText().includes("Generate (or refresh) the living product spec")) {`,
    `  fs.writeFileSync(".smithers/spec/features.json", JSON.stringify([{ id: "known-feature", title: "Known Feature", summary: "Invalid draft left by fake agent", status: "not-real", priority: "p0", owner: "product", missing: [] }], null, 2) + "\\n");`,
    `}`,
    `if (process.env.SMITHERS_FAKE_CODEX_INVALID_AFTER_REVIEW === "1" && promptText().includes("Adversarially review the freshly generated spec")) {`,
    `  fs.writeFileSync(".smithers/spec/features.json", JSON.stringify([{ id: "known-feature", title: "Known Feature", summary: "Review corrupted the spec after the first build", status: "not-real", priority: "p0", owner: "product", missing: [] }], null, 2) + "\\n");`,
    `}`,
    `const outputIndex = args.indexOf("--output-last-message");`,
    `if (outputIndex >= 0 && args[outputIndex + 1]) fs.writeFileSync(args[outputIndex + 1], "\\u0060\\u0060\\u0060json\\n" + payload + "\\n\\u0060\\u0060\\u0060\\n", "utf8");`,
    `process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");`,
    ``,
  ].join("\n"));
  chmodSync(join(binDir, "codex"), 0o755);
}

function writeFakeClaude(binDir: string) {
  writeFileSync(join(binDir, "claude"), [
    `#!/usr/bin/env node`,
    `const fs = require("node:fs");`,
    `const args = process.argv.slice(2);`,
    `if (args.join(" ") === "auth status") { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) + "\\n"); process.exit(0); }`,
    `const prompt = args.join("\\n");`,
    `const task = prompt.includes("Generate (or refresh) the living product spec") ? "draft-spec" : prompt.includes("Adversarially review the freshly generated spec") ? "review" : "unknown";`,
    `const payload = task === "review" ? { approved: true, corrections: [], summary: "fake claude review approved generated docs" } : { status: "ready", featuresWritten: 1, updatedFiles: [".smithers/spec/features.json", ".smithers/spec/content/overview.md"], summary: "fake claude draft refreshed the DDD spec" };`,
    `fs.appendFileSync("claude-calls.jsonl", JSON.stringify({ task, args, prompt, payload }) + "\\n");`,
    `const answer = "\\u0060\\u0060\\u0060json\\n" + JSON.stringify(payload) + "\\n\\u0060\\u0060\\u0060\\n";`,
    `process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-claude-ddd-generate-docs" }) + "\\n");`,
    `process.stdout.write(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: answer }] } }) + "\\n");`,
    `process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: answer, session_id: "fake-claude-ddd-generate-docs" }) + "\\n");`,
    ``,
  ].join("\n"));
  chmodSync(join(binDir, "claude"), 0o755);
}

function writeFakeSmithers(binDir: string, body: string) {
  writeFileSync(join(binDir, "smithers"), `#!/usr/bin/env node\n${body}\n`);
  chmodSync(join(binDir, "smithers"), 0o755);
}

async function runGenerate(
  repo: { root: string; binDir: string },
  runId: string,
  input: Record<string, unknown>,
  options: { fakeCodexResponse?: string; invalidAfterDraft?: boolean; invalidAfterReview?: boolean } = {},
) {
  return withDddProcessEnvLock(async () => {
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const previousTestAgentPath = process.env.SMITHERS_TEST_AGENT_PATH;
    const previousFakeCodex = process.env.SMITHERS_FAKE_CODEX_RESPONSE;
    const previousInvalidAfterDraft = process.env.SMITHERS_FAKE_CODEX_INVALID_AFTER_DRAFT;
    const previousInvalidAfterReview = process.env.SMITHERS_FAKE_CODEX_INVALID_AFTER_REVIEW;
    process.chdir(repo.root);
    process.env.PATH = `${repo.binDir}:${previousPath ?? ""}`;
    process.env.SMITHERS_TEST_AGENT_PATH = process.env.PATH;
    execFileSync("which", ["codex"], { env: process.env, stdio: "pipe" });
    if (options.fakeCodexResponse !== undefined) process.env.SMITHERS_FAKE_CODEX_RESPONSE = options.fakeCodexResponse;
    if (options.invalidAfterDraft) process.env.SMITHERS_FAKE_CODEX_INVALID_AFTER_DRAFT = "1";
    else delete process.env.SMITHERS_FAKE_CODEX_INVALID_AFTER_DRAFT;
    if (options.invalidAfterReview) process.env.SMITHERS_FAKE_CODEX_INVALID_AFTER_REVIEW = "1";
    else delete process.env.SMITHERS_FAKE_CODEX_INVALID_AFTER_REVIEW;
    try {
      const tempWorkflowPath = join(repo.root, ".smithers/workflows/ddd-generate-docs.tsx");
      const mod = await import(`${tempWorkflowPath}?run=${runId}-${Date.now()}-${Math.random()}`);
      const gateway = new Gateway({ heartbeatMs: 50 });
      gateway.register("ddd-generate-docs", (mod as { default: Parameters<typeof gateway.register>[1] }).default);
      const auth = { triggeredBy: "e2e", scopes: ["*"], role: "operator", tokenId: null };
      await gateway.startRun("ddd-generate-docs", input, auth as Parameters<typeof gateway.startRun>[2], runId, { resume: false });
      await waitForGenerateRunToSettle(gateway, runId);
      gateways.push(gateway);
      return gateway;
    } finally {
      process.chdir(previousCwd);
      process.env.PATH = previousPath;
      if (previousTestAgentPath === undefined) delete process.env.SMITHERS_TEST_AGENT_PATH;
      else process.env.SMITHERS_TEST_AGENT_PATH = previousTestAgentPath;
      if (previousFakeCodex === undefined) delete process.env.SMITHERS_FAKE_CODEX_RESPONSE;
      else process.env.SMITHERS_FAKE_CODEX_RESPONSE = previousFakeCodex;
      if (previousInvalidAfterDraft === undefined) delete process.env.SMITHERS_FAKE_CODEX_INVALID_AFTER_DRAFT;
      else process.env.SMITHERS_FAKE_CODEX_INVALID_AFTER_DRAFT = previousInvalidAfterDraft;
      if (previousInvalidAfterReview === undefined) delete process.env.SMITHERS_FAKE_CODEX_INVALID_AFTER_REVIEW;
      else process.env.SMITHERS_FAKE_CODEX_INVALID_AFTER_REVIEW = previousInvalidAfterReview;
    }
  });
}

async function waitForGenerateRunToSettle(gateway: Gateway, runId: string, timeoutMs = 120_000) {
  const started = Date.now();
  let sawInflight = false;
  while (Date.now() - started < timeoutMs) {
    const inflight = gateway.inflightRuns.get(runId);
    if (inflight) {
      sawInflight = true;
      await inflight;
    }
    const run = await gatewayRequest(gateway, createConnectionContext(), "runs.get", { runId });
    const status = String(run.payload?.status ?? "");
    if (run.ok && ["finished", "success", "failed", "cancelled"].includes(status)) return;
    if (sawInflight && !gateway.inflightRuns.has(runId)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${runId} to settle`);
}

describe("ddd-generate-docs real workflow run", () => {
  test("uses the default Claude planning agent for draft and review before gated bug-scan kickoff", async () => {
    const repo = tempRepo();
    writeFakeClaude(repo.binDir);
    const runId = "ddd-generate-docs-default-claude";
    const gateway = await runGenerate(repo, runId, {});
    const connection = createConnectionContext();

    const draft = await nodeOutput(gateway, connection, runId, "draft-spec");
    expect(draft.row.status).toBe("ready");
    expect(draft.row.summary).toBe("fake claude draft refreshed the DDD spec");

    const build = await nodeOutput(gateway, connection, runId, "build");
    expect(build.row.passed).toBe(true);

    const review = await nodeOutput(gateway, connection, runId, "review");
    expect(review.row.approved).toBe(true);
    expect(review.row.summary).toBe("fake claude review approved generated docs");

    const kickoff = await nodeOutput(gateway, connection, runId, "kickoff-bug-scan");
    expect(kickoff.row.launched).toBe(true);
    expect(kickoff.row.bugScanRunId).toBe("run-ddd-bugscan-123");

    const calls = readFileSync(join(repo.root, "claude-calls.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { task: string; args: string[]; prompt: string });
    expect(calls.map((call) => call.task)).toEqual(["draft-spec", "review"]);
    expect(calls.every((call) => call.args.includes("--model") && call.args.includes("claude-fable-5"))).toBe(true);
    expect(calls[0]!.prompt).toContain("Generate (or refresh) the living product spec");
    expect(calls[0]!.prompt).toContain("Survey:");
    expect(calls[1]!.prompt).toContain("Adversarially review the freshly generated spec");
    expect(calls[1]!.prompt).toContain('"passed": true');
  }, 120_000);

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

  test("blocks the detached bug scan when draft leaves the real spec build failing", async () => {
    const repo = tempRepo();
    writeFakeSmithers(
      repo.binDir,
      "require('node:fs').writeFileSync('smithers-invoked.txt', 'unexpected'); process.stdout.write('detached run-should-not-exist\\n');",
    );
    const fakeCodexResponse = JSON.stringify({
      status: "ready",
      featuresWritten: 1,
      updatedFiles: [".smithers/spec/features.json"],
      approved: true,
      corrections: [],
      summary: "fake review approved even though build failed",
    });
    const runId = "ddd-generate-docs-build-blocked";
    const gateway = await runGenerate(
      repo,
      runId,
      { useClaudeForPlanning: false, runBugScan: true },
      { fakeCodexResponse, invalidAfterDraft: true },
    );
    const connection = createConnectionContext();

    const draft = await nodeOutput(gateway, connection, runId, "draft-spec");
    expect(draft.row.status).toBe("ready");
    expect(readFileSync(join(repo.root, ".smithers/spec/features.json"), "utf8")).toContain('"status": "not-real"');

    const build = await nodeOutput(gateway, connection, runId, "build");
    expect(build.row.passed).toBe(false);
    expect(build.row.summary).toContain("Spec build failed:");
    expect(build.row.summary.length).toBeLessThanOrEqual(4_050);

    const review = await nodeOutput(gateway, connection, runId, "review");
    expect(review.row.approved).toBe(true);

    const kickoff = await nodeOutput(gateway, connection, runId, "kickoff-bug-scan");
    expect(kickoff.row.launched).toBe(false);
    expect(kickoff.row.bugScanRunId).toBe("");
    expect(kickoff.row.summary).toContain("the generated spec build failed");
    expect(existsSync(join(repo.root, "smithers-invoked.txt"))).toBe(false);
  }, 120_000);

  test("reruns the build after review and blocks bug scan when review corrupts the spec", async () => {
    const repo = tempRepo();
    writeFakeSmithers(
      repo.binDir,
      "require('node:fs').writeFileSync('smithers-invoked.txt', 'unexpected'); process.stdout.write('detached run-should-not-exist\\n');",
    );
    const fakeCodexResponse = JSON.stringify({
      status: "ready",
      featuresWritten: 1,
      updatedFiles: [".smithers/spec/features.json"],
      approved: true,
      corrections: [],
      summary: "fake review approved after corrupting the generated spec",
    });
    const runId = "ddd-generate-docs-review-corrupts-spec";
    const gateway = await runGenerate(
      repo,
      runId,
      { useClaudeForPlanning: false, runBugScan: true },
      { fakeCodexResponse, invalidAfterReview: true },
    );
    const connection = createConnectionContext();

    const build = await nodeOutput(gateway, connection, runId, "build");
    expect(build.row.passed).toBe(true);

    const review = await nodeOutput(gateway, connection, runId, "review");
    expect(review.row.approved).toBe(true);
    expect(readFileSync(join(repo.root, ".smithers/spec/features.json"), "utf8")).toContain('"status": "not-real"');

    const postReviewBuild = await nodeOutput(gateway, connection, runId, "post-review-build");
    expect(postReviewBuild.row.passed).toBe(false);
    expect(postReviewBuild.row.summary).toContain("Spec build failed:");

    const generatedFeatures = readFileSync(join(repo.root, ".smithers/ui/ddd-features.generated.ts"), "utf8");
    expect(generatedFeatures).toContain('"status": "partial"');
    expect(generatedFeatures).not.toContain("not-real");

    const kickoff = await nodeOutput(gateway, connection, runId, "kickoff-bug-scan");
    expect(kickoff.row.launched).toBe(false);
    expect(kickoff.row.bugScanRunId).toBe("");
    expect(kickoff.row.summary).toContain("the generated spec build failed");
    expect(existsSync(join(repo.root, "smithers-invoked.txt"))).toBe(false);
  }, 120_000);
});
