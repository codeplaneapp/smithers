import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Gateway } from "smithers-orchestrator";
import {
  createConnectionContext,
  createDddFixtureRepo,
  gatewayRequest,
  nodeOutput,
  runDddWorkflow,
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
    expect(materialized.row.tickets[0].content).toContain("Prove DDD workflow execution");
    const ticketPath = join(repo.root, ".smithers/tickets/docs-driven-development--ddd-run-fallback--01-docs-driven-development.md");
    expect(existsSync(ticketPath)).toBe(true);
    expect(readFileSync(ticketPath, "utf8")).toContain("Task type: e2e");

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

  test("captures editor metaTicket payload and skips work when implementation approval is withheld", async () => {
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
    expect(work.ok).toBe(false);
    expect(work.error?.code).toBe("NodeNotFound");

    const summary = await nodeOutput(gateway, connection, runId, "round-summary");
    expect(summary.row.status).toBe("partial");
    expect(summary.row.remaining).toEqual([]);
  }, 120_000);
});
