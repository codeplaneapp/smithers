import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKFLOW = path.join(ROOT, ".smithers/workflows/implement-testing-framework-e2e.tsx");

describe("implement-testing-framework-e2e workflow", () => {
  test("renders the required durable orchestration graph", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, "apps/cli/src/index.js"), "graph", WORKFLOW, "--compact"],
      {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    const graph = `${result.stdout}\n${result.stderr}`;
    for (const nodeId of [
      "validate-input-and-agents",
      "research",
      "plan",
      "implement",
      "capture-initial-evidence",
      "initial-sol-review",
      "capture-consensus-iteration",
      "capture-sol-readiness",
      "sol-readiness-review",
      "verify-sol-readiness-snapshot",
      "assess-sol-readiness",
      "consensus-sol-review",
      "consensus-fable-review",
      "verify-review-snapshot",
      "assess-consensus",
      "final-verify-and-summarize",
    ]) {
      expect(graph).toContain(`id: ${nodeId}`);
    }
    expect(graph).toContain("id: final-consensus");
    expect(graph).toContain("id: sol-readiness");
    expect(graph).toContain("onMaxReached: fail");
    expect(graph).toContain('maxConcurrency: "2"');
  }, 30_000);

  test("keeps reviewers read-only and fails closed on evidence freshness", () => {
    const source = readFileSync(WORKFLOW, "utf8");

    expect(source).toContain('model: "gpt-5.6-luna"');
    expect(source).toContain('model: "gpt-5.6-sol"');
    expect(source).toContain('model: "claude-fable-5"');
    expect(source.match(/sandbox: "read-only"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain('sandbox: "workspace-write"');
    expect(source.match(/yolo: false/g)?.length).toBe(4);
    expect(source).toContain("fullAuto: true");
    expect(source).toContain('permissionMode: "plan"');
    expect(source).toContain('ANTHROPIC_API_KEY: ""');
    expect(source).toContain('ANTHROPIC_AUTH_TOKEN: ""');
    expect(source).toContain("loadPriorFablePlan");
    expect(source).toContain("refusing to substitute a synthetic plan");
    expect(source).toContain("Exact durable Claude Fable 5 plan reused from");

    expect(source).toContain('createHash("sha256")');
    expect(source).toContain("currentSol.iterationId === currentEvidence.iterationId");
    expect(source).toContain("currentSol.reviewedDiffDigest === currentEvidence.diffDigest");
    expect(source).toContain("currentFable.iterationId === currentEvidence.iterationId");
    expect(source).toContain("currentFable.reviewedDiffDigest === currentEvidence.diffDigest");
    expect(source).toContain('ctx.latest(outputs.snapshotVerification, "verify-review-snapshot")');
    expect(source).toContain('ctx.latest(outputs.snapshotVerification, "verify-sol-readiness-snapshot")');
    expect(source).toContain('ctx.latest(outputs.consensus, "assess-consensus")');
    expect(source).toContain('ctx.latest(outputs.readiness, "assess-sol-readiness")');
    expect(source).toContain('ctx.latest(outputs.improvement, "sol-readiness-luna-improvement")');
    expect(
      source.match(/!targetChangedBetweenHeads\(expected\.currentGitHead, currentGitHead\)/g)?.length,
    ).toBe(2);
    expect(source).toContain("targetChangedBetweenHeads(finalEvidence.currentGitHead, currentGitHead)");
    expect(source).toContain("Target-scoped committed files changed after consensus; final approval is stale.");
    expect(source).toContain('previousImprovement={promptJson(previousReadinessImprovement)}');
    expect(source).not.toContain('ctx.outputMaybe(outputs.consensus, { nodeId: "assess-consensus" })');
    expect(source).not.toContain('ctx.outputMaybe(outputs.readiness, { nodeId: "assess-sol-readiness" })');
    expect(source).toContain('onMaxReached="fail"');
    expect(source.indexOf('<Loop id="sol-readiness"')).toBeLessThan(source.indexOf('<Loop id="final-consensus"'));

    expect(source).not.toContain("allRequiredChecksPassed: true");
    expect(source).not.toContain("reviews.at(-2)");
    expect(source).not.toContain("<UI");
    expect(source).not.toContain("../ui/implement-testing-framework-e2e");
  });

  test("real agent adapters emit enforced read-only reviewer commands", async () => {
    const codex = await new CodexAgent({
      model: "gpt-5.6-sol",
      yolo: false,
      sandbox: "read-only",
    }).buildCommand({ cwd: ROOT, prompt: "review", options: {} });
    expect(codex.args).toContain("--sandbox");
    expect(codex.args[codex.args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(codex.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");

    const claude = await new ClaudeCodeAgent({
      model: "claude-fable-5",
      yolo: false,
      permissionMode: "plan",
      env: { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" },
    }).buildCommand({ cwd: ROOT, prompt: "review", options: {} });
    expect(claude.args).toContain("--permission-mode");
    expect(claude.args[claude.args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(claude.args).not.toContain("--allow-dangerously-skip-permissions");
    expect(claude.args).not.toContain("--dangerously-skip-permissions");
  });

  test("runs real verification profiles instead of agent-asserted pass flags", () => {
    const source = readFileSync(WORKFLOW, "utf8");

    expect(source).toContain("pnpm -C packages/testing test");
    expect(source).toContain("pnpm -C packages/testing typecheck");
    expect(source).toContain("pnpm typecheck");
    expect(source).toContain("pnpm test");
    expect(source).toContain("pnpm -C e2e typecheck");
    expect(source).toContain("bun test e2e/testing-framework");
    expect(source).toContain("pnpm -C e2e test:faults");
    expect(source).toContain("pnpm -C e2e test");
    expect(source).toContain("checks.every((result) => result.passed)");
    expect(source).toContain("verification commands changed target-scoped tracked files");
    expect(source).toContain("targetChangedBetweenHeads");
    expect(source).toContain('"packages/testing"');
    expect(source).toContain('"e2e/package.json"');
    expect(source).toContain('"e2e/harness/engineChildRunner.ts"');
    expect(source).toContain('"e2e/testing-framework"');
    expect(source).toContain('"pnpm-lock.yaml"');
    expect(source).toContain('spawnChild("bash", ["-c", command]');
    expect(source).toContain("fatalSignatures");
    expect(source).toContain("rejected zero exit because output matched fatal signature");
    expect(source).toContain('signalProcessGroup("SIGTERM")');
    expect(source).toContain('signalProcessGroup("SIGKILL")');
    expect(source).toContain("retries={AGENT_RETRIES}");
    expect(source).toContain('fableReview={promptJson(null)}');
    expect(source).not.toContain('id="verify-initial-fix"');
    expect(source).not.toContain('id="verify-improvement"');
    expect(source).not.toContain("this workflow forbids commits");
  });
});
