import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Gateway } from "smithers-orchestrator";
import {
  createConnectionContext,
  createDddFixtureRepo,
  dddFixtureFeature,
  fakeAgentResponse,
  gatewayRequest,
  nodeOutput,
  runDddWorkflow,
  withDddFixtureExecutionEnv,
  type DddFixtureRepo,
} from "./docsDrivenDevelopmentRunFixture.ts";

const gateways: Gateway[] = [];
const repos: DddFixtureRepo[] = [];

afterEach(async () => {
  while (gateways.length > 0) {
    try {
      await gateways.pop()!.close();
    } catch {}
  }
  while (repos.length > 0) repos.pop()!.cleanup();
});

async function waitForRunToSettle(gateway: Gateway, runId: string, timeoutMs = 120_000) {
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
    if (run.ok && ["finished", "success", "failed", "cancelled"].includes(status)) return run;
    if (sawInflight && !gateway.inflightRuns.has(runId)) return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${runId} to settle`);
}

describe("docs-driven-development real workflow run", () => {
  test("executes the real graph with seeded fake agents and materializes tickets", async () => {
    const repo = createDddFixtureRepo();
    repos.push(repo);

    const runId = "ddd-run-fallback";
    const gateway = await runDddWorkflow(repo, runId, {
      maxAgents: 1,
      maxRounds: 1,
      useClaudeForPlanning: false,
      runImplementation: true,
      implementationApproved: true,
    });
    gateways.push(gateway);
    const connection = createConnectionContext();

    const bootstrap = await nodeOutput(gateway, connection, runId, "bootstrap");
    expect(bootstrap.status).toBe("produced");
    expect(bootstrap.row.docsBuildPassed).toBe(true);
    expect(bootstrap.row.commandsRun).toEqual(["bun .smithers/lib/ddd/build.ts"]);
    expect(existsSync(join(repo.root, ".smithers/docs-driven-development/bootstrap-latest.json"))).toBe(true);

    const metaTicket = await nodeOutput(gateway, connection, runId, "metaTicket");
    expect(metaTicket.row.created).toBe(false);
    expect(metaTicket.row.summary).toContain("No editor-created docs change");
    expect(metaTicket.row.docsDiff).toContain("Uncommitted docs edit");

    const audit = await nodeOutput(gateway, connection, runId, "audit");
    expect(audit.row.generatedSiteBuilds).toBe(true);
    expect(audit.row.notes).toEqual(["codex fake output audit note"]);

    const spec = await nodeOutput(gateway, connection, runId, "spec-update");
    expect(spec.row.status).toBe("partial");
    expect(spec.row.summary).toBe("codex fake output");

    const triage = await nodeOutput(gateway, connection, runId, "triage");
    expect(triage.row.summary).toBe("codex fake output");
    expect(triage.row.selected[0]).toMatchObject({
      slot: 1,
      featureId: "docs-driven-development",
      agent: "sonnet",
      taskType: "e2e",
    });

    const materialized = await nodeOutput(gateway, connection, runId, "materialize-tickets");
    expect(materialized.row.created).toBe(1);
    expect(materialized.row.tickets[0].featureId).toBe("docs-driven-development");
    expect(materialized.row.tickets[0].featureTitle).toBe("Docs driven development");
    expect(materialized.row.tickets[0].content).toContain("Prove DDD workflow execution");
    expect(materialized.row.tickets[0].path).toMatch(
      /^docs-driven-development--ddd-run-fallback--01-docs-driven-development-[0-9a-f]{8}$/,
    );
    const ticketPath = join(repo.root, ".smithers/tickets", `${materialized.row.tickets[0].path}.md`);
    expect(existsSync(ticketPath)).toBe(true);
    expect(readFileSync(ticketPath, "utf8")).toContain("Task type: e2e");
    expect(readFileSync(ticketPath, "utf8")).toContain("Feature title: Docs driven development");

    const work = await nodeOutput(gateway, connection, runId, "work:1");
    expect(work.row.summary).toBe("codex fake output");
    expect(work.row.testsRun).toContain("bun test tests/docs-driven-development-run.e2e.test.ts");

    const review = await nodeOutput(gateway, connection, runId, "cycle-review");
    expect(review.row.approved).toBe(true);
    expect(review.row.summary).toBe("codex fake output");

    const summary = await nodeOutput(gateway, connection, runId, "round-summary");
    expect(summary.row.status).toBe("partial");
    expect(summary.row.remaining).toContain("partial: docs-driven-development - codex fake output");

    const run = await gatewayRequest(gateway, connection, "runs.get", { runId });
    expect(run.ok).toBe(true);
    expect(["finished", "success"]).toContain(String(run.payload.status));
  }, 120_000);

  test("captures editor metaTicket payload and pauses before work when implementation approval is withheld", async () => {
    const repo = createDddFixtureRepo();
    repos.push(repo);

    const runId = "ddd-run-editor";
    const gateway = await runDddWorkflow(repo, runId, {
      maxAgents: 1,
      maxRounds: null,
      useClaudeForPlanning: true,
      runImplementation: true,
      requireImplementationApproval: true,
      implementationApproved: false,
      metaTicket: {
        title: "Docs change: overview.md",
        source: "e2e-editor",
        docPath: "overview.md",
        featureIds: ["docs-driven-development"],
        changedFiles: [
          {
            path: "overview.md",
            beforeMarkdown: "# Overview\n",
            afterMarkdown: "# Overview\n\nEdited from e2e.\n",
          },
        ],
        beforeMarkdown: "# Overview\n",
        afterMarkdown: "# Overview\n\nEdited from e2e.\n",
        changedAtIso: "2026-07-02T00:00:00.000Z",
      },
    });
    gateways.push(gateway);
    const connection = createConnectionContext();

    const metaTicket = await nodeOutput(gateway, connection, runId, "metaTicket");
    expect(metaTicket.row.created).toBe(true);
    expect(metaTicket.row.title).toBe("Docs change: overview.md");
    expect(metaTicket.row.source).toBe("e2e-editor");
    expect(metaTicket.row.changedFiles[0].afterMarkdown).toContain("Edited from e2e");

    const triage = await nodeOutput(gateway, connection, runId, "triage");
    expect(triage.row.summary).toBe("claude fake output");

    const materialized = await nodeOutput(gateway, connection, runId, "materialize-tickets");
    expect(materialized.row.created).toBe(1);

    const work = await gatewayRequest(gateway, connection, "getNodeOutput", { runId, nodeId: "work:1", iteration: 0 });
    expect(work.ok).toBe(true);
    expect(work.payload.status).toBe("pending");
    expect(work.payload.row).toBeNull();

    const summary = await gatewayRequest(gateway, connection, "getNodeOutput", { runId, nodeId: "round-summary", iteration: 0 });
    expect(summary.ok).toBe(false);
    expect(summary.error?.code).toBe("NodeNotFound");

    const run = await gatewayRequest(gateway, connection, "runs.get", { runId });
    expect(run.ok).toBe(true);
    expect(["waiting", "waiting-approval", "paused", "running"]).toContain(String(run.payload.status));
  }, 120_000);

  test("implementation approval resumes through work, cycle review, and summary", async () => {
    const repo = createDddFixtureRepo();
    repos.push(repo);

    const runId = "ddd-run-approval-resume";
    const gateway = await runDddWorkflow(repo, runId, {
      maxAgents: 1,
      maxRounds: 1,
      useClaudeForPlanning: false,
      runImplementation: true,
      requireImplementationApproval: true,
      implementationApproved: false,
    });
    gateways.push(gateway);
    const connection = createConnectionContext();

    const pending = await gatewayRequest(gateway, connection, "approvals.list", { runId });
    expect(pending.ok).toBe(true);
    expect((pending.payload as Array<Record<string, unknown>>)[0]).toMatchObject({
      runId,
      nodeId: "approve-implementation",
      iteration: 0,
    });

    const beforeWork = await gatewayRequest(gateway, connection, "getNodeOutput", { runId, nodeId: "work:1", iteration: 0 });
    expect(beforeWork.ok).toBe(true);
    expect(beforeWork.payload.status).toBe("pending");
    expect(beforeWork.payload.row).toBeNull();

    await withDddFixtureExecutionEnv(repo, async () => {
      const approved = await gatewayRequest(gateway, connection, "submitApproval", {
        runId,
        nodeId: "approve-implementation",
        iteration: 0,
        approved: true,
        note: "approved by e2e",
      });
      expect(approved.ok).toBe(true);
      expect(approved.payload).toMatchObject({ runId, nodeId: "approve-implementation", approved: true });
      await waitForRunToSettle(gateway, runId);
    });

    const approval = await nodeOutput(gateway, connection, runId, "approve-implementation");
    expect(approval.row.approved).toBe(true);

    const work = await nodeOutput(gateway, connection, runId, "work:1");
    expect(work.status).toBe("produced");
    expect(work.row.summary).toBe("codex fake output");
    expect(work.row.testsRun).toContain("bun test tests/docs-driven-development-run.e2e.test.ts");

    const review = await nodeOutput(gateway, connection, runId, "cycle-review");
    expect(review.status).toBe("produced");
    expect(review.row.approved).toBe(true);

    const summary = await nodeOutput(gateway, connection, runId, "round-summary");
    expect(summary.status).toBe("produced");
    expect(summary.row.status).toBe("partial");

    const run = await gatewayRequest(gateway, connection, "runs.get", { runId });
    expect(run.ok).toBe(true);
    expect(["finished", "success"]).toContain(String(run.payload.status));
  }, 180_000);

  test("denying implementation approval fails the run without work output", async () => {
    const repo = createDddFixtureRepo();
    repos.push(repo);

    const runId = "ddd-run-approval-deny";
    const gateway = await runDddWorkflow(repo, runId, {
      maxAgents: 1,
      maxRounds: 1,
      useClaudeForPlanning: false,
      runImplementation: true,
      requireImplementationApproval: true,
      implementationApproved: false,
    });
    gateways.push(gateway);
    const connection = createConnectionContext();

    await withDddFixtureExecutionEnv(repo, async () => {
      const denied = await gatewayRequest(gateway, connection, "submitApproval", {
        runId,
        nodeId: "approve-implementation",
        iteration: 0,
        approved: false,
        note: "deny by e2e",
      });
      expect(denied.ok).toBe(true);
      expect(denied.payload).toMatchObject({ runId, nodeId: "approve-implementation", approved: false });
      await waitForRunToSettle(gateway, runId);
    });

    const approval = await nodeOutput(gateway, connection, runId, "approve-implementation");
    expect(approval.status).toBe("failed");
    expect(approval.row).toBeNull();

    const work = await gatewayRequest(gateway, connection, "getNodeOutput", { runId, nodeId: "work:1", iteration: 0 });
    expect(work.ok).toBe(true);
    expect(work.payload.status).toBe("pending");
    expect(work.payload.row).toBeNull();

    const run = await gatewayRequest(gateway, connection, "runs.get", { runId });
    expect(run.ok).toBe(true);
    expect(String(run.payload.status)).toBe("failed");
  }, 180_000);

  test("continues past a done round summary while features.json still has open records", async () => {
    const repo = createDddFixtureRepo({
      features: [
        dddFixtureFeature({
          status: "partial",
          tests: [],
          missing: ["Keep the feature open after an over-optimistic round summary."],
        }),
      ],
    });
    repos.push(repo);

    const runId = "ddd-run-done-but-open";
    const gateway = await runDddWorkflow(
      repo,
      runId,
      {
        maxAgents: 1,
        maxRounds: 2,
        useClaudeForPlanning: false,
        runImplementation: true,
        implementationApproved: true,
      },
      {
        agentResponsesByNode: {
          "spec-update": JSON.parse(fakeAgentResponse("spec fake output", { status: "ready" })),
          "work:1": JSON.parse(fakeAgentResponse("work fake output", { status: "done" })),
          "cycle-review": JSON.parse(fakeAgentResponse("review fake output", {
            approved: true,
            blockingFindings: [],
            inefficiencies: [],
          })),
        },
      },
    );
    gateways.push(gateway);
    const connection = createConnectionContext();

    const summary0 = await nodeOutput(gateway, connection, runId, "round-summary", 0);
    expect(summary0.row.status).toBe("done");
    expect(summary0.row.summary).toContain("All tracked P0/P1 features are complete");

    const bootstrap1 = await nodeOutput(gateway, connection, runId, "bootstrap", 1);
    expect(bootstrap1.status).toBe("produced");
    expect(bootstrap1.row.docsBuildPassed).toBe(true);

    const summary1 = await nodeOutput(gateway, connection, runId, "round-summary", 1);
    expect(summary1.row.status).toBe("done");

    const featureRows = JSON.parse(readFileSync(join(repo.root, ".smithers/spec/features.json"), "utf8")) as Array<{ status?: string }>;
    expect(featureRows[0]?.status).toBe("partial");
  }, 120_000);

  test("stops after one clean done round when features.json has no open records", async () => {
    const repo = createDddFixtureRepo({
      features: [
        dddFixtureFeature({
          status: "fixed",
          missing: [],
          tests: ["bun test tests/docs-driven-development-run.e2e.test.ts"],
        }),
      ],
    });
    repos.push(repo);

    const runId = "ddd-run-clean-complete";
    const gateway = await runDddWorkflow(
      repo,
      runId,
      {
        maxAgents: 1,
        maxRounds: 5,
        useClaudeForPlanning: false,
        runImplementation: true,
        implementationApproved: true,
      },
      {
        agentResponsesByNode: {
          audit: JSON.parse(fakeAgentResponse("clean audit", {
            broken: [],
            partial: [],
            missingE2E: [],
            missingDocs: [],
            notes: [],
          })),
          "spec-update": JSON.parse(fakeAgentResponse("clean spec", { status: "ready" })),
          triage: JSON.parse(fakeAgentResponse("clean triage")),
          "work:1": JSON.parse(fakeAgentResponse("clean work", {
            status: "done",
            summary: "completed the final DDD proof",
          })),
          "cycle-review": JSON.parse(fakeAgentResponse("clean review", {
            approved: true,
            blockingFindings: [],
            inefficiencies: [],
          })),
        },
      },
    );
    gateways.push(gateway);
    const connection = createConnectionContext();

    const summary = await nodeOutput(gateway, connection, runId, "round-summary", 0);
    expect(summary.row.status).toBe("done");
    expect(summary.row.summary).toContain("All tracked P0/P1 features are complete");

    const secondBootstrap = await gatewayRequest(gateway, connection, "getNodeOutput", { runId, nodeId: "bootstrap", iteration: 1 });
    expect(secondBootstrap.ok).toBe(false);
    expect(secondBootstrap.error?.code).toBe("IterationNotFound");

    const run = await gatewayRequest(gateway, connection, "runs.get", { runId });
    expect(run.ok).toBe(true);
    expect(["finished", "success"]).toContain(String(run.payload.status));
  }, 120_000);

  test("empty triage materializes no tickets, skips work, and still reaches a partial summary", async () => {
    const repo = createDddFixtureRepo();
    repos.push(repo);

    const runId = "ddd-run-empty-triage";
    const gateway = await runDddWorkflow(
      repo,
      runId,
      {
        maxAgents: 1,
        maxRounds: 1,
        useClaudeForPlanning: false,
        runImplementation: true,
        implementationApproved: true,
      },
      {
        agentResponsesByNode: {
          triage: JSON.parse(fakeAgentResponse("empty triage", {
            selected: [],
            summary: "no worthwhile DDD work selected",
          })),
          "work:1": {
            slot: 1,
            featureId: "",
            status: "skipped",
            filesChanged: [],
            testsRun: [],
            issuesCreated: [],
            summary: "No triage item selected for slot 1.",
          },
          "cycle-review": JSON.parse(fakeAgentResponse("empty triage review", {
            approved: true,
            blockingFindings: [],
            inefficiencies: [],
          })),
        },
      },
    );
    gateways.push(gateway);
    const connection = createConnectionContext();

    const triage = await nodeOutput(gateway, connection, runId, "triage");
    expect(triage.row.selected).toEqual([]);
    expect(triage.row.summary).toBe("no worthwhile DDD work selected");

    const materialized = await nodeOutput(gateway, connection, runId, "materialize-tickets");
    expect(materialized.row.created).toBe(0);
    expect(materialized.row.tickets).toEqual([]);
    expect(materialized.row.summary).toContain("No triage selections");

    const work = await gatewayRequest(gateway, connection, "getNodeOutput", { runId, nodeId: "work:1", iteration: 0 });
    expect(work.ok).toBe(true);
    expect(work.payload.status).toBe("produced");
    expect(work.payload.row).toMatchObject({ slot: 1, status: "skipped" });

    const summary = await nodeOutput(gateway, connection, runId, "round-summary");
    expect(summary.row.status).toBe("partial");
    expect(summary.row.summary).toContain("Continue the improvement loop");

    const run = await gatewayRequest(gateway, connection, "runs.get", { runId });
    expect(run.ok).toBe(true);
    expect(["finished", "success"]).toContain(String(run.payload.status));
  }, 120_000);

  test("docs-editor dispatch with implementation disabled reaches final summary without work", async () => {
    const repo = createDddFixtureRepo();
    repos.push(repo);

    const runId = "ddd-run-editor-no-work";
    const gateway = await runDddWorkflow(repo, runId, {
      maxAgents: 1,
      maxRounds: 1,
      useClaudeForPlanning: false,
      runImplementation: false,
      implementationApproved: false,
      metaTicket: {
        title: "Docs change: overview.md",
        source: "e2e-editor-no-work",
        docPath: "overview.md",
        featureIds: ["docs-driven-development"],
        changedFiles: [
          {
            path: "overview.md",
            beforeMarkdown: "# Overview\n",
            afterMarkdown: "# Overview\n\nDispatch without implementation.\n",
          },
        ],
        beforeMarkdown: "# Overview\n",
        afterMarkdown: "# Overview\n\nDispatch without implementation.\n",
        changedAtIso: "2026-07-02T01:00:00.000Z",
      },
    });
    gateways.push(gateway);
    const connection = createConnectionContext();

    const metaTicket = await nodeOutput(gateway, connection, runId, "metaTicket");
    expect(metaTicket.row.created).toBe(true);
    expect(metaTicket.row.source).toBe("e2e-editor-no-work");

    for (const nodeId of ["audit", "spec-update", "triage", "materialize-tickets", "cycle-review", "round-summary"]) {
      const output = await nodeOutput(gateway, connection, runId, nodeId);
      expect(output.status).toBe("produced");
    }

    const materialized = await nodeOutput(gateway, connection, runId, "materialize-tickets");
    expect(materialized.row.created).toBe(1);

    const summary = await nodeOutput(gateway, connection, runId, "round-summary");
    expect(summary.row.status).toBe("partial");
    expect(summary.row.summary).toContain("Continue the improvement loop");

    const work = await gatewayRequest(gateway, connection, "getNodeOutput", { runId, nodeId: "work:1", iteration: 0 });
    expect(work.ok).toBe(false);
    expect(work.error?.code).toBe("NodeNotFound");

    const run = await gatewayRequest(gateway, connection, "runs.get", { runId });
    expect(run.ok).toBe(true);
    expect(["finished", "success"]).toContain(String(run.payload.status));
  }, 120_000);

  test("continues through build failure and truncated docs diff without implementation work", async () => {
    const repo = createDddFixtureRepo();
    repos.push(repo);

    mkdirSync(join(repo.root, "packages/core/src"), { recursive: true });
    writeFileSync(join(repo.root, "packages/core/src/index.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "packages/core/src/index.ts"], { cwd: repo.root, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "track code fixture"], { cwd: repo.root, stdio: "pipe" });
    writeFileSync(join(repo.root, "packages/core/src/index.ts"), "export const value = 2;\n");

    const truncationMarker = "TRUNCATION_MARKER_END";
    writeFileSync(
      join(repo.root, ".smithers/spec/features.json"),
      `${JSON.stringify([
        dddFixtureFeature({
          status: "not-real",
          summary: `${"large docs diff ".repeat(1_200)}${truncationMarker}`,
        }),
      ], null, 2)}\n`,
    );

    const runId = "ddd-run-build-failure-truncated";
    const gateway = await runDddWorkflow(repo, runId, {
      maxAgents: 1,
      maxRounds: 1,
      useClaudeForPlanning: false,
      runImplementation: false,
      implementationApproved: false,
      metaTicket: {
        title: "Huge docs edit",
        source: "e2e-truncation",
        docPath: "features.json",
        featureIds: ["docs-driven-development"],
        changedFiles: [
          {
            path: "features.json",
            beforeMarkdown: "before",
            afterMarkdown: "after",
          },
        ],
        beforeMarkdown: "before",
        afterMarkdown: "after",
        changedAtIso: "2026-07-02T02:00:00.000Z",
      },
    });
    gateways.push(gateway);
    const connection = createConnectionContext();

    const bootstrap = await nodeOutput(gateway, connection, runId, "bootstrap");
    expect(bootstrap.row.docsBuildPassed).toBe(false);
    expect(bootstrap.row.commandsRun).toEqual(["bun .smithers/lib/ddd/build.ts"]);
    const bootstrapArtifact = join(repo.root, ".smithers/docs-driven-development/bootstrap-latest.json");
    expect(existsSync(bootstrapArtifact)).toBe(true);
    const bootstrapJson = JSON.parse(readFileSync(bootstrapArtifact, "utf8"));
    expect(bootstrapJson.docsBuildPassed).toBe(false);
    expect(bootstrapJson.summary).toContain("Spec build failed");

    const metaTicket = await nodeOutput(gateway, connection, runId, "metaTicket");
    expect(metaTicket.row.created).toBe(true);
    expect(metaTicket.row.gitStatus).toContain(".smithers/spec/features.json");
    expect(metaTicket.row.gitStatus).toContain("packages/core/src/index.ts");
    expect(metaTicket.row.codeDiffFiles).toEqual(["packages/core/src/index.ts"]);
    expect(metaTicket.row.docsDiffTruncated).toBe(true);
    expect(metaTicket.row.docsDiff).toContain("...[truncated ");
    expect(metaTicket.row.docsDiff).not.toContain(truncationMarker);
    expect(metaTicket.row.docsDiff.length).toBeLessThan(12_300);
    expect(existsSync(metaTicket.row.docsDiffArtifactPath)).toBe(true);
    const fullDiff = readFileSync(metaTicket.row.docsDiffArtifactPath, "utf8");
    expect(fullDiff).toContain(truncationMarker);
    expect(fullDiff).toContain('"status": "not-real"');

    for (const nodeId of ["audit", "spec-update", "triage", "materialize-tickets", "cycle-review", "round-summary"]) {
      const output = await nodeOutput(gateway, connection, runId, nodeId);
      expect(output.status).toBe("produced");
      expect(JSON.stringify(output.row).length).toBeLessThan(5_000);
    }

    const audit = await nodeOutput(gateway, connection, runId, "audit");
    expect(audit.row.generatedSiteBuilds).toBe(true);
    const materialized = await nodeOutput(gateway, connection, runId, "materialize-tickets");
    expect(materialized.row.created).toBe(1);
    const summary = await nodeOutput(gateway, connection, runId, "round-summary");
    expect(summary.row.status).toBe("partial");

    const work = await gatewayRequest(gateway, connection, "getNodeOutput", { runId, nodeId: "work:1", iteration: 0 });
    expect(work.ok).toBe(false);
    expect(work.error?.code).toBe("NodeNotFound");
  }, 120_000);
});
